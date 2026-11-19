"use server";

import { createHash, randomUUID } from "node:crypto";
import { unexpectedResult } from "@/lib/actions";
import { requireModule } from "@/lib/auth/guard";
import {
  costImportIdentity,
  costImportRowSchema,
  costImportSubmissionSchema,
  type CostImportActionResult,
  type CostImportRowOutcome,
  type CostImportRowSubmission,
} from "@/modules/ai-costs/import";
import { validateCostEntryInput, type CostEntryInput } from "@/modules/ai-costs/ledger";
import {
  createImportedCostEntries,
  findExistingImportKeys,
  saveCostImportMapping,
} from "@/modules/ai-costs/repository";
import { recordAuditEventSafely } from "@/modules/audit/repository";
import { canManageBusinessRecords } from "@/modules/identity/workspace";

/**
 * Preview (`dryRun`) and commit of a CSV cost import (M9-05).
 *
 * A Server Action is a public endpoint: every row is validated again here, one by one,
 * so a tampered row is rejected with its reason instead of failing the whole file.
 * Duplicates are decided here, against the database and within the file, never by the
 * browser. A commit stores the mapping for the source and leaves an audit entry with
 * counts only.
 */

const COST_IMPORT_MANAGER_MESSAGE =
  "Seuls le propriétaire et les administrateurs de l'espace peuvent importer des coûts.";

function importKey(identity: string): string {
  return createHash("sha256").update(identity).digest("hex");
}

function firstMessage(error: { issues: { message: string }[] }): string {
  return error.issues[0]?.message ?? "Ligne invalide.";
}

function entryInput(row: CostImportRowSubmission, importId: string, capturedAt: Date): CostEntryInput {
  return {
    amount: row.amount,
    currency: row.currency,
    actuality: "observed",
    source: { kind: "import", importId, rowNumber: row.line, capturedAt },
    periodStart: row.date,
    periodEnd: row.periodEnd ?? row.date,
    // The ledger has no label column: the label leads the notes.
    notes: row.notes ? `${row.label}\n${row.notes}` : row.label,
  };
}

export async function importCostsAction(values: unknown): Promise<CostImportActionResult> {
  const user = await requireModule("ai-costs", "write");

  if (!canManageBusinessRecords(user.workspace.role)) {
    return { status: "error", message: COST_IMPORT_MANAGER_MESSAGE };
  }

  const parsed = costImportSubmissionSchema.safeParse(values);
  if (!parsed.success) {
    return { status: "invalid", message: `${firstMessage(parsed.error)} Rien n'a été enregistré.` };
  }

  const input = parsed.data;
  const workspaceId = user.workspace.id;
  const importId = input.dryRun ? null : randomUUID();
  const capturedAt = new Date();
  const outcomes: CostImportRowOutcome[] = [];
  const candidates: { line: number; key: string; row: CostImportRowSubmission; byReference: boolean }[] = [];
  const firstLineByKey = new Map<string, number>();

  for (const [index, raw] of input.rows.entries()) {
    const line =
      typeof raw === "object" && raw !== null && typeof (raw as { line?: unknown }).line === "number"
        ? (raw as { line: number }).line
        : index + 1;
    const checked = costImportRowSchema.safeParse(raw);

    if (!checked.success) {
      outcomes.push({ line, status: "rejected", reason: firstMessage(checked.error) });
      continue;
    }

    const row = checked.data;

    try {
      validateCostEntryInput(entryInput(row, importId ?? "preview", capturedAt));
    } catch {
      outcomes.push({
        line,
        status: "rejected",
        reason: "Contenu refusé par le registre des coûts (caractères de contrôle ou valeur hors limites).",
      });
      continue;
    }

    const key = importKey(costImportIdentity(input.source, row));
    const earlier = firstLineByKey.get(key);

    if (earlier !== undefined) {
      outcomes.push({
        line,
        status: "duplicate",
        reason:
          row.reference !== null
            ? `Même référence que la ligne ${earlier} du fichier.`
            : `Identique à la ligne ${earlier} du fichier (sans référence).`,
      });
      continue;
    }

    firstLineByKey.set(key, line);
    candidates.push({ line, key, row, byReference: row.reference !== null });
  }

  try {
    const existing = await findExistingImportKeys(
      workspaceId,
      candidates.map((candidate) => candidate.key),
    );
    const fresh = candidates.filter((candidate) => {
      if (!existing.has(candidate.key)) return true;
      outcomes.push({
        line: candidate.line,
        status: "duplicate",
        reason: candidate.byReference
          ? "Déjà importée : même source et même référence."
          : "Déjà importée : même source, période, devise, montant et libellé.",
      });
      return false;
    });

    if (importId === null) {
      outcomes.push(...fresh.map((candidate) => ({ line: candidate.line, status: "new" as const, reason: null })));
    } else {
      const created = await createImportedCostEntries(
        workspaceId,
        fresh.map((candidate) => ({
          input: entryInput(candidate.row, importId, capturedAt),
          importKey: candidate.key,
        })),
      );

      for (const candidate of fresh) {
        outcomes.push(
          created.has(candidate.key)
            ? { line: candidate.line, status: "created", reason: null }
            : { line: candidate.line, status: "duplicate", reason: "Importée entre-temps par un autre import." },
        );
      }

      await saveCostImportMapping(workspaceId, {
        source: input.source,
        delimiter: input.delimiter,
        hasHeader: input.hasHeader,
        columns: input.columns as Record<string, string>,
        defaultCurrency: input.defaultCurrency,
      });
    }
  } catch (error) {
    if (importId !== null) {
      await recordAuditEventSafely({
        workspaceId,
        actorId: user.id,
        action: "cost.import",
        entityType: "COST_IMPORT",
        entityId: importId,
        outcome: "FAILED",
      });
    }

    const failure = unexpectedResult("importCosts", error);
    return {
      status: "error",
      message: failure.status === "error" ? failure.message : "Import impossible pour le moment.",
    };
  }

  outcomes.sort((left, right) => left.line - right.line);
  const count = (status: CostImportRowOutcome["status"]) =>
    outcomes.filter((outcome) => outcome.status === status).length;
  const summary = {
    importId,
    received: input.rows.length,
    created: count("created"),
    duplicates: count("duplicate"),
    rejected: count("rejected"),
    rejectedInFile: input.rejectedInFile,
  };

  if (importId !== null) {
    await recordAuditEventSafely({
      workspaceId,
      actorId: user.id,
      action: "cost.import",
      entityType: "COST_IMPORT",
      entityId: importId,
      outcome: "SUCCESS",
      metadata: {
        received: summary.received,
        created: summary.created,
        duplicates: summary.duplicates,
        rejected: summary.rejected,
        rejectedInFile: summary.rejectedInFile,
      },
    });
  }

  return { status: "ok", dryRun: importId === null, summary, outcomes };
}
