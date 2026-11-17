"use server";

import { revalidatePath } from "next/cache";
import {
  invalidResult,
  rejectedResult,
  unexpectedResult,
  type ActionResult,
} from "@/lib/actions";
import { requirePermission } from "@/lib/auth/guard";
import { recordIdInput } from "@/lib/validation";
import {
  ALERT_KINDS,
  alertRulesInputSchema,
  type AlertKind,
  type AlertRuleConfig,
  type AlertRulesInput,
} from "@/modules/alerts/domain";
import { refreshAlerts } from "@/modules/alerts/refresh";
import { dismissAlert, saveAlertRules } from "@/modules/alerts/repository";

/**
 * Write Server Actions for the alert engine (BP-05).
 *
 * Two writes exist, and neither touches the ledger: dismissing an episode silences its
 * warning, saving the rules changes what the engine watches. An alert is an observation
 * of the owner's own data — the actions can only edit observations.
 */

/** The validated form input, as the effective configuration per kind. */
function toRuleConfigs(input: AlertRulesInput): AlertRuleConfig[] {
  const configs: Record<AlertKind, AlertRuleConfig> = {
    LOW_BALANCE: {
      kind: "LOW_BALANCE",
      enabled: input.lowBalance.enabled,
      thresholdAmount: input.lowBalance.thresholdAmount,
      thresholdCurrency: input.lowBalance.thresholdCurrency,
      thresholdPercent: null,
      thresholdDays: null,
    },
    BUDGET_OVERRUN: {
      kind: "BUDGET_OVERRUN",
      enabled: input.budgetOverrun.enabled,
      thresholdAmount: null,
      thresholdCurrency: null,
      thresholdPercent: input.budgetOverrun.thresholdPercent,
      thresholdDays: null,
    },
    BUDGET_THRESHOLD: {
      kind: "BUDGET_THRESHOLD",
      enabled: input.budgetThreshold.enabled,
      thresholdAmount: null,
      thresholdCurrency: null,
      thresholdPercent: input.budgetThreshold.thresholdPercent,
      thresholdDays: null,
    },
    UNUSUAL_EXPENSE: {
      kind: "UNUSUAL_EXPENSE",
      enabled: input.unusualExpense.enabled,
      thresholdAmount: input.unusualExpense.thresholdAmount,
      thresholdCurrency: input.unusualExpense.thresholdCurrency,
      thresholdPercent: null,
      thresholdDays: null,
    },
    STALE_INTEGRATION: {
      kind: "STALE_INTEGRATION",
      enabled: input.staleIntegration.enabled,
      thresholdAmount: null,
      thresholdCurrency: null,
      thresholdPercent: null,
      thresholdDays: input.staleIntegration.thresholdDays,
    },
    OVERDUE_EVENT: {
      kind: "OVERDUE_EVENT",
      enabled: input.overdueEvent.enabled,
      thresholdAmount: null,
      thresholdCurrency: null,
      thresholdPercent: null,
      thresholdDays: input.overdueEvent.thresholdDays,
    },
  };

  return ALERT_KINDS.map((kind) => configs[kind]);
}

/**
 * Dismisses one active alert: the owner has seen it and does not want it repeated while
 * the condition holds. A stamp is recorded, never the ledger.
 */
export async function dismissAlertAction(values: unknown): Promise<ActionResult> {
  const user = await requirePermission("write");

  const parsed = recordIdInput.safeParse(values);
  if (!parsed.success) {
    return invalidResult(parsed.error);
  }

  try {
    const dismissed = await dismissAlert(user.workspace.id, parsed.data.id, new Date());
    if (!dismissed) {
      return rejectedResult(
        "id",
        "Alerte introuvable : elle a peut-être déjà été écartée ou résolue.",
      );
    }
  } catch (error) {
    return unexpectedResult("dismissAlert", error);
  }

  revalidatePath("/alerts");
  revalidatePath("/dashboard");
  return { status: "ok" };
}

/**
 * Saves the rules and immediately re-evaluates.
 *
 * Re-running the pass here is what makes the setting tangible: enabling a rule shows its
 * findings at once, and a disabled rule resolves the episodes it was watching (its
 * alerts close, and a later re-enable opens fresh ones).
 */
export async function saveAlertRulesAction(values: unknown): Promise<ActionResult> {
  const user = await requirePermission("write");

  const parsed = alertRulesInputSchema.safeParse(values);
  if (!parsed.success) {
    return invalidResult(parsed.error);
  }

  try {
    await saveAlertRules(user.workspace.id, toRuleConfigs(parsed.data));
    await refreshAlerts(user.workspace.id);
  } catch (error) {
    return unexpectedResult("saveAlertRules", error);
  }

  revalidatePath("/alerts");
  revalidatePath("/dashboard");
  return { status: "ok" };
}
