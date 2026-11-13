"use server";

import { revalidatePath } from "next/cache";
import {
  invalidResult,
  rejectedResult,
  unexpectedResult,
  type ActionResult,
} from "@/lib/actions";
import { parseMonthKey } from "@/lib/dates";
import { recordAuditEventSafely } from "@/modules/audit/repository";
import {
  billingRateInputSchema,
  canReadInternalRates,
  internalCostRateInputSchema,
} from "@/modules/micro-business/rates";
import {
  upsertBillingRate,
  upsertInternalCostRate,
} from "@/modules/micro-business/repository";
import { requireBusinessManager } from "./manager-guard";

/**
 * Write Server Actions for rate cards (M10-03).
 *
 * Billing rates follow the business-manager guard. Internal cost rates add a second,
 * deliberate check: the dedicated `read-internal-rates` permission, granted to the
 * owner only for now. Without it, the action refuses before reading or writing any
 * confidential figure.
 *
 * Saving the same client or workspace and month corrects the change point (upsert).
 * Nothing is deleted, so a period never loses the rate that was in force.
 */

const CLIENT_NOT_FOUND = "Client introuvable : il a peut-être été supprimé.";
const INTERNAL_RATES_DENIED =
  "Les coûts internes sont confidentiels : seul le propriétaire de l'espace peut les consulter et les enregistrer.";

function refreshRatePages(): void {
  revalidatePath("/micro-business/rates");
  revalidatePath("/micro-business");
}

export async function saveBillingRateAction(values: unknown): Promise<ActionResult> {
  const guard = await requireBusinessManager();
  if ("refusal" in guard) {
    return guard.refusal;
  }

  const parsed = billingRateInputSchema.safeParse(values);
  if (!parsed.success) {
    return invalidResult(parsed.error);
  }

  const { year, month } = parseMonthKey(parsed.data.month);

  let saved;
  try {
    saved = await upsertBillingRate({
      workspaceId: guard.user.workspace.id,
      clientId: parsed.data.clientId,
      year,
      month,
      hourlyRate: parsed.data.hourlyRate,
      currency: parsed.data.currency,
    });
  } catch (error) {
    return unexpectedResult("saveBillingRate", error);
  }

  if (!saved) {
    return rejectedResult("clientId", CLIENT_NOT_FOUND);
  }

  await recordAuditEventSafely({
    workspaceId: guard.user.workspace.id,
    actorId: guard.user.id,
    action: "rate.billing_write",
    entityType: "BILLING_RATE",
    entityId: saved.id,
    outcome: "SUCCESS",
    metadata: { year, month, currency: saved.currency },
  });

  refreshRatePages();
  return {
    status: "ok",
    message: "Tarif client enregistré pour ce mois et les suivants.",
  };
}

export async function saveInternalCostRateAction(values: unknown): Promise<ActionResult> {
  const guard = await requireBusinessManager();
  if ("refusal" in guard) {
    return guard.refusal;
  }

  // The confidentiality check comes before parsing or querying anything: a role
  // without the permission learns nothing about the stored internal rates.
  if (!canReadInternalRates(guard.user.workspace.role)) {
    return { status: "error", message: INTERNAL_RATES_DENIED };
  }

  const parsed = internalCostRateInputSchema.safeParse(values);
  if (!parsed.success) {
    return invalidResult(parsed.error);
  }

  const { year, month } = parseMonthKey(parsed.data.month);

  let saved;
  try {
    saved = await upsertInternalCostRate({
      workspaceId: guard.user.workspace.id,
      year,
      month,
      hourlyRate: parsed.data.hourlyRate,
      currency: parsed.data.currency,
    });
  } catch (error) {
    return unexpectedResult("saveInternalCostRate", error);
  }

  await recordAuditEventSafely({
    workspaceId: guard.user.workspace.id,
    actorId: guard.user.id,
    action: "rate.internal_write",
    entityType: "INTERNAL_COST_RATE",
    entityId: saved.id,
    outcome: "SUCCESS",
    metadata: { year, month, currency: saved.currency },
  });

  refreshRatePages();
  return {
    status: "ok",
    message: "Coût interne enregistré pour ce mois et les suivants.",
  };
}
