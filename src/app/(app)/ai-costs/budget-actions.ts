"use server";

import { revalidatePath } from "next/cache";
import {
  invalidResult,
  rejectedResult,
  unexpectedResult,
  type ActionResult,
} from "@/lib/actions";
import { requireModule } from "@/lib/auth/guard";
import { recordIdInput } from "@/lib/validation";
import { refreshAlerts } from "@/modules/alerts/refresh";
import { aiBudgetInputSchema } from "@/modules/ai-costs/budgets";
import {
  AiBudgetLimitError,
  deleteAiBudget,
  upsertAiBudget,
} from "@/modules/ai-costs/repository";
import { recordAuditEventSafely } from "@/modules/audit/repository";

/**
 * Server Actions for AI budgets (M12-03).
 *
 * A budget only changes what the alert engine watches: nothing is cut off and the
 * ledger is never written. Each change re-runs the alert pass, so an overrun shows at
 * once and a deleted budget's episodes resolve.
 */

function refreshPages(): void {
  revalidatePath("/ai-costs");
  revalidatePath("/alerts");
  revalidatePath("/dashboard");
}

export async function saveAiBudgetAction(values: unknown): Promise<ActionResult> {
  const user = await requireModule("ai-costs", "write");

  const parsed = aiBudgetInputSchema.safeParse(values);
  if (!parsed.success) {
    return invalidResult(parsed.error);
  }

  let saved: { id: string; created: boolean };
  try {
    saved = await upsertAiBudget(user.workspace.id, parsed.data);
  } catch (error) {
    if (error instanceof AiBudgetLimitError) {
      return rejectedResult("dimension", "Nombre maximal de budgets IA atteint : supprimez-en un d'abord.");
    }
    return unexpectedResult("saveAiBudget", error);
  }

  await recordAuditEventSafely({
    workspaceId: user.workspace.id,
    actorId: user.id,
    action: "ai_budget.create",
    entityType: "AI_BUDGET",
    entityId: saved.id,
    outcome: "SUCCESS",
    metadata: { dimension: parsed.data.dimension, currency: parsed.data.currency, replaced: !saved.created },
  });
  // The budget is saved: a failed re-evaluation is logged, and the next pass catches up.
  await refreshAlerts(user.workspace.id).catch((error) => unexpectedResult("refreshAlerts", error));

  refreshPages();
  return {
    status: "ok",
    message: saved.created ? "Budget IA enregistré." : "Budget IA mis à jour : ce périmètre en avait déjà un.",
  };
}

export async function deleteAiBudgetAction(values: unknown): Promise<ActionResult> {
  const user = await requireModule("ai-costs", "write");

  const parsed = recordIdInput.safeParse(values);
  if (!parsed.success) {
    return invalidResult(parsed.error);
  }

  try {
    if (!(await deleteAiBudget(user.workspace.id, parsed.data.id))) {
      return rejectedResult("id", "Budget IA introuvable : il a peut-être déjà été supprimé.");
    }
  } catch (error) {
    return unexpectedResult("deleteAiBudget", error);
  }

  await recordAuditEventSafely({
    workspaceId: user.workspace.id,
    actorId: user.id,
    action: "ai_budget.delete",
    entityType: "AI_BUDGET",
    entityId: parsed.data.id,
    outcome: "SUCCESS",
  });
  // The budget is saved: a failed re-evaluation is logged, and the next pass catches up.
  await refreshAlerts(user.workspace.id).catch((error) => unexpectedResult("refreshAlerts", error));

  refreshPages();
  return { status: "ok" };
}
