"use server";

import { revalidatePath } from "next/cache";
import {
  invalidResult,
  isUniqueConstraintError,
  rejectedResult,
  unexpectedResult,
  type ActionResult,
} from "@/lib/actions";
import { requireModule } from "@/lib/auth/guard";
import { recordIdInput } from "@/lib/validation";
import { categoryMismatchReason, type CategorySummary } from "@/modules/budget/domain";
import {
  ALREADY_CONFIRMED_MESSAGE,
  decisionBlockedReason,
  forecastOccurrenceRef,
  recurringEntryInputSchema,
  recurringEntryUpdateSchema,
  signedForecastAmount,
  startDateChangeRefusedReason,
} from "@/modules/budget/recurrence";
import {
  countDecidedOccurrences,
  createRecurringEntry,
  createTransaction,
  decideRecurringOccurrence,
  deletePendingOccurrences,
  deleteRecurringEntry,
  findAccount,
  findCategory,
  findRecurringEntry,
  findRecurringOccurrence,
  updateRecurringEntry,
} from "@/modules/budget/repository";
import { resolveTransactionInput } from "@/modules/budget/transactions";

/**
 * Write Server Actions for recurring forecasts (BP-03).
 *
 * A definition writes nothing to the ledger, and neither does a skip or a dismiss:
 * the only door from a forecast into the accounts is the explicit confirmation, which
 * goes through the same validation and the same `createTransaction` as a manually
 * typed entry. Every identifier arriving from the browser is looked up for the
 * signed-in owner, and a decision is terminal, so replayed requests fail loudly
 * instead of rewriting an audit trail.
 */

/**
 * Creates a recurring definition.
 *
 * The account and the category are resolved with the session, exactly like a manual
 * transaction: a replayed identifier from another owner's book simply matches nothing.
 * The kind rule applies to the series too — an expected expense on an income category
 * would land in the wrong column the day it is confirmed.
 */
export async function createRecurringEntryAction(values: unknown): Promise<ActionResult> {
  const user = await requireModule("budget", "write");

  const parsed = recurringEntryInputSchema.safeParse(values);
  if (!parsed.success) {
    return invalidResult(parsed.error);
  }

  const input = parsed.data;

  try {
    const account = await findAccount(user.workspace.id, input.accountId);
    if (!account) {
      return rejectedResult("accountId", "Compte introuvable.");
    }

    const category: CategorySummary | null = input.categoryId
      ? await findCategory(user.workspace.id, input.categoryId)
      : null;

    if (input.categoryId && !category) {
      return rejectedResult("categoryId", "Catégorie introuvable.");
    }

    const categoryMismatch = categoryMismatchReason(input.type, category);
    if (categoryMismatch) {
      return rejectedResult("categoryId", categoryMismatch);
    }

    await createRecurringEntry({
      workspaceId: user.workspace.id,
      accountId: account.id,
      categoryId: input.categoryId,
      type: input.type,
      label: input.label,
      amount: input.amount,
      frequency: input.frequency,
      startDate: input.startDate,
      endDate: input.endDate,
    });
  } catch (error) {
    return unexpectedResult("createRecurringEntry", error);
  }

  revalidatePath("/budget");
  return { status: "ok" };
}

/**
 * Edits one recurring definition — label, amount, account, category, cadence, dates.
 *
 * Two deliberate rules: the start date can no longer move once an occurrence has been
 * decided (the series' history is dated, and a confirmation holds a transaction); when
 * the cadence or the start date does move, the still-pending occurrences are deleted so
 * the month opening re-materialises them on the new rule, instead of leaving échéances
 * computed under a rule that no longer exists.
 */
export async function updateRecurringEntryAction(values: unknown): Promise<ActionResult> {
  const user = await requireModule("budget", "write");

  const parsed = recurringEntryUpdateSchema.safeParse(values);
  if (!parsed.success) {
    return invalidResult(parsed.error);
  }

  const input = parsed.data;

  try {
    const entry = await findRecurringEntry(user.workspace.id, input.id);
    if (!entry) {
      return rejectedResult("id", "Série introuvable : elle a peut-être été supprimée entre-temps.");
    }

    const account = await findAccount(user.workspace.id, input.accountId);
    if (!account) {
      return rejectedResult("accountId", "Compte introuvable.");
    }

    const category: CategorySummary | null = input.categoryId
      ? await findCategory(user.workspace.id, input.categoryId)
      : null;

    if (input.categoryId && !category) {
      return rejectedResult("categoryId", "Catégorie introuvable.");
    }

    const categoryMismatch = categoryMismatchReason(input.type, category);
    if (categoryMismatch) {
      return rejectedResult("categoryId", categoryMismatch);
    }

    const startDateMoved = input.startDate.getTime() !== entry.startDate.getTime();
    const cadenceMoved = startDateMoved || input.frequency !== entry.frequency;

    if (startDateMoved) {
      const decided = await countDecidedOccurrences(user.workspace.id, entry.id);
      const refused = startDateChangeRefusedReason(decided);

      if (refused) {
        return rejectedResult("startDate", refused);
      }
    }

    const updated = await updateRecurringEntry(user.workspace.id, entry.id, {
      accountId: account.id,
      categoryId: input.categoryId,
      type: input.type,
      label: input.label,
      amount: input.amount,
      frequency: input.frequency,
      startDate: input.startDate,
      endDate: input.endDate,
    });

    if (!updated) {
      return rejectedResult("id", "Série introuvable : elle a peut-être été supprimée entre-temps.");
    }

    if (cadenceMoved) {
      // The pending rows were computed on the old rule; the next month opening rebuilds
      // the matching ones. Decided occurrences are history and stay untouched.
      await deletePendingOccurrences(user.workspace.id, entry.id);
    }
  } catch (error) {
    return unexpectedResult("updateRecurringEntry", error);
  }

  revalidatePath("/budget");
  return { status: "ok" };
}

/**
 * Deletes one recurring definition.
 *
 * Refused as soon as one occurrence carries a decision: a skipped or dismissed
 * occurrence is the audit trail itself, and a confirmation holds the only link to its
 * transaction. A series is stopped with its end date, not by erasing what it produced.
 * Pending occurrences, on the other hand, are the series' own future and go with it.
 */
export async function deleteRecurringEntryAction(values: unknown): Promise<ActionResult> {
  const user = await requireModule("budget", "write");

  const parsed = recordIdInput.safeParse(values);
  if (!parsed.success) {
    return invalidResult(parsed.error);
  }

  try {
    const decided = await countDecidedOccurrences(user.workspace.id, parsed.data.id);
    if (decided > 0) {
      return rejectedResult(
        "id",
        "Cette série compte déjà des échéances traitées : elle est conservée pour l'audit. Utilisez sa date de fin pour l'arrêter.",
      );
    }

    const deleted = await deleteRecurringEntry(user.workspace.id, parsed.data.id);
    if (!deleted) {
      return rejectedResult("id", "Série introuvable : elle a peut-être déjà été supprimée.");
    }
  } catch (error) {
    return unexpectedResult("deleteRecurringEntry", error);
  }

  revalidatePath("/budget");
  return { status: "ok" };
}

/**
 * Confirms one occurrence: it becomes a real transaction.
 *
 * Everything comes from the manual creation path: `resolveTransactionInput` re-checks
 * that the account and the category belong to the owner and that the kind and the sign
 * are consistent, then `createTransaction` writes with the account's currency — no
 * conversion. The transaction is dated on the **occurrence day**, not on the day of
 * the click: the échéance is the fact being recorded. The stable
 * `forecast:{occurrenceId}` reference makes a replay fail on the unique
 * (account, reference) instead of booking the line twice.
 */
export async function confirmRecurringOccurrenceAction(values: unknown): Promise<ActionResult> {
  const user = await requireModule("budget", "write");

  const parsed = recordIdInput.safeParse(values);
  if (!parsed.success) {
    return invalidResult(parsed.error);
  }

  try {
    const occurrence = await findRecurringOccurrence(user.workspace.id, parsed.data.id);
    if (!occurrence) {
      return rejectedResult("id", "Échéance introuvable : rechargez la page.");
    }

    const blocked = decisionBlockedReason(occurrence.status);
    if (blocked) {
      return rejectedResult("id", blocked);
    }

    const entry = await findRecurringEntry(user.workspace.id, occurrence.recurringId);
    if (!entry) {
      return rejectedResult(
        "id",
        "La série de cette échéance n'existe plus : rechargez la page.",
      );
    }

    const resolved = await resolveTransactionInput(user.workspace.id, {
      accountId: entry.accountId,
      categoryId: entry.categoryId,
      type: entry.type,
      label: entry.label,
      // The definition stores a magnitude; the sign is the type's business.
      amount: signedForecastAmount(entry.type, entry.amount),
      operationDate: occurrence.date,
      notes: null,
    });

    if (!resolved.ok) {
      return resolved.result;
    }

    const transaction = await createTransaction({
      workspaceId: user.workspace.id,
      accountId: resolved.account.id,
      categoryId: entry.categoryId,
      type: entry.type,
      label: entry.label,
      amount: signedForecastAmount(entry.type, entry.amount),
      currency: resolved.account.currency,
      operationDate: occurrence.date,
      notes: null,
      externalRef: forecastOccurrenceRef(occurrence.id),
    });

    const decided = await decideRecurringOccurrence(user.workspace.id, occurrence.id, {
      status: "CONFIRMED",
      transactionId: transaction.id,
    });

    if (!decided) {
      return rejectedResult(
        "id",
        "L'échéance a reçu une autre décision entre-temps : l'opération créée reste enregistrée dans le mois, rechargez la page.",
      );
    }
  } catch (error) {
    // The unique (account, externalRef) is the race guard for two crossed clicks; it
    // answers with the same message as the pre-check.
    if (isUniqueConstraintError(error)) {
      return rejectedResult("id", ALREADY_CONFIRMED_MESSAGE);
    }

    return unexpectedResult("confirmRecurringOccurrence", error);
  }

  revalidatePath("/budget");
  revalidatePath("/dashboard");
  return { status: "ok" };
}

/** The two non-events share one implementation: nothing is ever written to the ledger. */
async function decideOccurrence(
  status: "SKIPPED" | "DISMISSED",
  values: unknown,
  context: string,
): Promise<ActionResult> {
  const user = await requireModule("budget", "write");

  const parsed = recordIdInput.safeParse(values);
  if (!parsed.success) {
    return invalidResult(parsed.error);
  }

  try {
    const occurrence = await findRecurringOccurrence(user.workspace.id, parsed.data.id);
    if (!occurrence) {
      return rejectedResult("id", "Échéance introuvable : rechargez la page.");
    }

    const blocked = decisionBlockedReason(occurrence.status);
    if (blocked) {
      return rejectedResult("id", blocked);
    }

    const decided = await decideRecurringOccurrence(user.workspace.id, occurrence.id, { status });
    if (!decided) {
      return rejectedResult(
        "id",
        "Cette échéance a reçu une décision entre-temps : rechargez la page.",
      );
    }
  } catch (error) {
    return unexpectedResult(context, error);
  }

  revalidatePath("/budget");
  return { status: "ok" };
}

/**
 * Marks one occurrence as « passée »: the expected movement did not happen.
 *
 * No transaction is created — that is the whole point — and the decision stays visible
 * in the month's decisions, with its date. « Écartée » is the same refusal worded for
 * an échéance that was already recorded by hand or became irrelevant.
 */
export async function skipRecurringOccurrenceAction(values: unknown): Promise<ActionResult> {
  return decideOccurrence("SKIPPED", values, "skipRecurringOccurrence");
}

/** Marks one occurrence as « écartée »: it leaves the to-do list without claiming it happened. */
export async function dismissRecurringOccurrenceAction(values: unknown): Promise<ActionResult> {
  return decideOccurrence("DISMISSED", values, "dismissRecurringOccurrence");
}
