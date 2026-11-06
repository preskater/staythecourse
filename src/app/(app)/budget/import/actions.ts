"use server";

import { revalidatePath } from "next/cache";
import { invalidResult, unexpectedResult } from "@/lib/actions";
import { requireModule } from "@/lib/auth/guard";
import { toDateOnlyString } from "@/lib/dates";
import {
  IMPORT_SCAN_LIMIT,
  importExternalRef,
  importSubmissionSchema,
  type ImportActionResult,
  type ImportSummary,
} from "@/modules/budget/import";
import {
  createImportedTransactions,
  findManagedAccount,
  listCategories,
  listImportCandidates,
} from "@/modules/budget/repository";

/**
 * Writes the rows the import page previewed, after validating them again server-side.
 *
 * A Server Action is a public endpoint: the browser's preview is a comfort, never a
 * permission. Every identifier is looked up for the signed-in owner (the account must
 * exist, be active and carry the currency), every amount is parsed exactly, and the
 * duplicate check runs against the account's stored rows — nothing relies on what the
 * file claimed. The import never leaves the ledger conventions: the sign decides the
 * type, transfers are never created, and no category is invented.
 */

/** The comparison key of a row: operation date, collapsed label, exact amount. */
function duplicateKey(date: Date, label: string, amount: string): string {
  return `${toDateOnlyString(date)}|${label.replace(/\s+/g, " ").trim()}|${amount}`;
}

export async function importTransactionsAction(
  values: unknown,
): Promise<ImportActionResult> {
  const user = await requireModule("budget", "write");

  const parsed = importSubmissionSchema.safeParse(values);
  if (!parsed.success) {
    const failure = invalidResult(parsed.error);
    return failure.status === "invalid"
      ? failure
      : {
          status: "invalid",
          message: "L'import contient des lignes invalides. Rien n'a été enregistré.",
          fieldErrors: {},
        };
  }

  const input = parsed.data;

  try {
    const account = await findManagedAccount(user.workspace.id, input.accountId);
    if (!account) {
      return {
        status: "invalid",
        message: "Compte introuvable.",
        fieldErrors: { accountId: ["Compte introuvable."] },
      };
    }

    if (account.archivedAt !== null) {
      return {
        status: "invalid",
        message: "Ce compte est archivé : importez vers un compte actif.",
        fieldErrors: { accountId: ["Compte archivé."] },
      };
    }

    // The duplicate check reads the file's date window, bounded; one day is added to
    // the upper bound so the last day of the file is included (exclusive end).
    let minDate = input.rows[0].date;
    let maxDate = input.rows[0].date;
    for (const row of input.rows) {
      if (row.date.getTime() < minDate.getTime()) {
        minDate = row.date;
      }
      if (row.date.getTime() > maxDate.getTime()) {
        maxDate = row.date;
      }
    }
    const scanEnd = new Date(
      Date.UTC(maxDate.getUTCFullYear(), maxDate.getUTCMonth(), maxDate.getUTCDate() + 1),
    );

    const [candidates, categories] = await Promise.all([
      listImportCandidates({
        workspaceId: user.workspace.id,
        accountId: account.id,
        from: minDate,
        to: scanEnd,
        take: IMPORT_SCAN_LIMIT,
      }),
      listCategories(user.workspace.id),
    ]);

    if (candidates.truncated) {
      return {
        status: "error",
        message:
          "Ce compte porte trop d'opérations sur la période du fichier pour vérifier les doublons honnêtement. Réduisez la période du fichier, puis réessayez.",
      };
    }

    const existingKeys = new Set(
      candidates.rows.map((row) =>
        duplicateKey(row.operationDate, row.label, row.amount.toFixed(2)),
      ),
    );
    const existingRefs = new Set(
      candidates.rows
        .map((row) => row.externalRef)
        .filter((ref): ref is string => ref !== null),
    );

    // Categories are matched by exact name and kind — the sign decides the kind — and a
    // name that matches nothing leaves the row uncategorised and is counted, never
    // invented.
    const categoryByKey = new Map(
      categories.map((category) => [`${category.name}|${category.kind}`, category.id]),
    );

    const summary: ImportSummary = {
      received: input.rows.length,
      imported: 0,
      duplicatesSkipped: 0,
      unknownCategories: 0,
    };

    const toInsert: Parameters<typeof createImportedTransactions>[0][number][] = [];
    const seenKeys = new Set<string>();

    for (const row of input.rows) {
      const amount = row.amount.toFixed(2);
      const key = duplicateKey(row.date, row.label, amount);
      const reference =
        row.reference === null ? null : importExternalRef(row.reference);

      if (input.skipDuplicates) {
        if (
          existingKeys.has(key) ||
          seenKeys.has(key) ||
          (reference !== null && existingRefs.has(reference))
        ) {
          summary.duplicatesSkipped += 1;
          continue;
        }
      }

      seenKeys.add(key);
      if (reference !== null) {
        existingRefs.add(reference);
      }

      const kind = row.amount.lessThan(0) ? "EXPENSE" : "INCOME";
      let categoryId: string | null = null;

      if (row.categoryName !== null) {
        const matched = categoryByKey.get(`${row.categoryName}|${kind}`) ?? null;
        if (matched) {
          categoryId = matched;
        } else {
          summary.unknownCategories += 1;
        }
      }

      toInsert.push({
        workspaceId: user.workspace.id,
        accountId: account.id,
        categoryId,
        type: kind,
        label: row.label,
        amount,
        currency: account.currency,
        operationDate: row.date,
        notes: row.notes,
        externalRef: reference,
      });
    }

    if (toInsert.length > 0) {
      const inserted = await createImportedTransactions(toInsert);
      summary.imported = inserted;
      // Rows the database skipped on an (account, reference) collision the read above
      // could not see — counted as duplicates rather than silently lost.
      summary.duplicatesSkipped += toInsert.length - inserted;
    }

    revalidatePath("/budget");
    revalidatePath("/dashboard");
    return { status: "ok", summary };
  } catch (error) {
    const failure = unexpectedResult("importTransactions", error);
    return {
      status: "error",
      message:
        failure.status === "error"
          ? failure.message
          : "Import impossible pour le moment. Réessayez dans un instant.",
    };
  }
}
