"use server";

import { revalidatePath } from "next/cache";
import {
  invalidResult,
  rejectedResult,
  unexpectedResult,
  type ActionResult,
} from "@/lib/actions";
import { recordIdInput } from "@/lib/validation";
import { recordAuditEventSafely } from "@/modules/audit/repository";
import { businessExpenseInputSchema } from "@/modules/micro-business/expenses";
import {
  createBusinessExpense,
  deleteBusinessExpense,
} from "@/modules/micro-business/repository";
import { requireBusinessManager } from "./manager-guard";

/**
 * Server Actions for recurring business expenses (M10-05).
 *
 * A definition never writes to the budget ledger: it only describes a planning series,
 * and its due dates are computed when the page renders. Deleting a definition removes
 * the series from future planning; there is no history to rewrite because no
 * occurrence was ever stored.
 */

const NOT_FOUND = "Charge récurrente introuvable : elle a peut-être déjà été supprimée.";

function refreshExpensePages(): void {
  revalidatePath("/micro-business/expenses");
  revalidatePath("/micro-business");
}

export async function createBusinessExpenseAction(
  values: unknown,
): Promise<ActionResult> {
  const guard = await requireBusinessManager();
  if ("refusal" in guard) {
    return guard.refusal;
  }

  const parsed = businessExpenseInputSchema.safeParse(values);
  if (!parsed.success) {
    return invalidResult(parsed.error);
  }

  let created: { id: string };
  try {
    created = await createBusinessExpense({
      workspaceId: guard.user.workspace.id,
      ...parsed.data,
    });
  } catch (error) {
    return unexpectedResult("createBusinessExpense", error);
  }

  await recordAuditEventSafely({
    workspaceId: guard.user.workspace.id,
    actorId: guard.user.id,
    action: "business_expense.create",
    entityType: "BUSINESS_EXPENSE",
    entityId: created.id,
    outcome: "SUCCESS",
    metadata: {
      kind: parsed.data.kind,
      frequency: parsed.data.frequency,
      currency: parsed.data.currency,
    },
  });

  refreshExpensePages();
  return {
    status: "ok",
    message: "Charge récurrente enregistrée en planification : elle n'écrit rien dans le budget.",
  };
}

export async function deleteBusinessExpenseAction(
  values: unknown,
): Promise<ActionResult> {
  const guard = await requireBusinessManager();
  if ("refusal" in guard) {
    return guard.refusal;
  }

  const parsed = recordIdInput.safeParse(values);
  if (!parsed.success) {
    return invalidResult(parsed.error);
  }

  let deleted: boolean;
  try {
    deleted = await deleteBusinessExpense(guard.user.workspace.id, parsed.data.id);
  } catch (error) {
    return unexpectedResult("deleteBusinessExpense", error);
  }

  if (!deleted) {
    return rejectedResult("id", NOT_FOUND);
  }

  await recordAuditEventSafely({
    workspaceId: guard.user.workspace.id,
    actorId: guard.user.id,
    action: "business_expense.delete",
    entityType: "BUSINESS_EXPENSE",
    entityId: parsed.data.id,
    outcome: "SUCCESS",
  });

  refreshExpensePages();
  return { status: "ok", message: "Charge récurrente supprimée de la planification." };
}
