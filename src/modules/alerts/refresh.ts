import Decimal from "decimal.js";
import { currentMonthKey, monthRange, parseMonthKey } from "@/lib/dates";
import {
  evaluateBudgetOverrun,
  evaluateBudgetThreshold,
  evaluateLowBalance,
  evaluateUnusualExpense,
} from "@/modules/budget/alerts";
import { buildBudgetReport } from "@/modules/budget/report";
import {
  listAccountBalanceTotals,
  listAccountsForManagement,
  listBudgets,
  listTransactionsForSeries,
} from "@/modules/budget/repository";
import { evaluateAiBudgetOverrun, evaluateAiBudgetThreshold } from "@/modules/ai-costs/budgets";
import { listAiBudgets, readAiBudgetSpend } from "@/modules/ai-costs/repository";
import { evaluateStaleIntegration } from "@/modules/integrations/alerts";
import { listConnections } from "@/modules/integrations/repository";
import { evaluateOverdueEvent } from "@/modules/real-estate/alerts";
import { listDueCashflows } from "@/modules/real-estate/repository";
import { planAlertChanges } from "./lifecycle";
import { applyAlertPlan, listAlerts, listAlertRules } from "./repository";
import { resolveAlertRules, type AlertKind } from "./domain";

/**
 * One evaluation pass of the alert engine (BP-05), run server-side on demand.
 *
 * Pages that warn the owner call this while rendering (the same on-demand pattern the
 * Prévisions tab uses to materialise a month): the conditions are read now, compared to
 * the stored episodes, and the differences are written — never the other way around.
 * No rule touches the ledger: an alert is an observation, and dismissing one only
 * silences the warning.
 *
 * The pass is bounded: accounts with their grouped balances, the month's budgets and
 * transactions, the connections, the due cashflows, the stored episodes. A read that
 * could be partial (the month series hitting its row bound) makes the depending rules
 * stay quiet rather than accuse on half-read data.
 */

export type AlertRefreshSummary = {
  created: number;
  refreshed: number;
  reopened: number;
  resolved: number;
  /** Episodes open after the pass. */
  active: number;
};

export async function refreshAlerts(
  workspaceId: string,
  options: { now?: Date } = {},
): Promise<AlertRefreshSummary> {
  const now = options.now ?? new Date();
  const monthKey = currentMonthKey(now);
  const { year, month } = parseMonthKey(monthKey);
  const range = monthRange(year, month);

  const [ruleRows, accounts, balanceTotals, budgets, monthSeries, connections, dueCashflows, existing, aiBudgets] =
    await Promise.all([
      listAlertRules(workspaceId),
      listAccountsForManagement(workspaceId),
      listAccountBalanceTotals(workspaceId),
      listBudgets(workspaceId, { year, month }),
      listTransactionsForSeries(workspaceId, { from: range.start, to: range.end }),
      listConnections(workspaceId),
      listDueCashflows(workspaceId, { until: now }),
      listAlerts(workspaceId),
      listAiBudgets(workspaceId),
    ]);
  // The month the budget rules above use (UTC key); spend follows the overview rule.
  const aiSpends =
    aiBudgets.length > 0 ? await readAiBudgetSpend(workspaceId, aiBudgets, range.start, range.end) : [];

  const rules = resolveAlertRules(ruleRows);
  const ruleFor = (kind: AlertKind) => rules.find((rule) => rule.kind === kind)!;

  // An account absent from the grouped read has nothing recorded: its balance stays
  // unknown (count 0) and the low-balance rule leaves it alone.
  const byAccount = new Map(balanceTotals.map((total) => [total.accountId, total]));
  const accountBalances = accounts
    .filter((account) => account.archivedAt === null)
    .map((account) => ({
      accountId: account.id,
      accountName: account.name,
      currency: account.currency,
      transactionCount: byAccount.get(account.id)?.transactionCount ?? 0,
      balance: byAccount.get(account.id)?.balance ?? new Decimal(0),
      lowBalanceThreshold: account.lowBalanceThreshold,
    }));

  // One report for both budget rules, so overrun and threshold can never disagree.
  const reportRows = buildBudgetReport(budgets, monthSeries.transactions);
  const budgetRuleOptions = { monthKey, truncated: monthSeries.truncated };

  const candidates = [
    ...evaluateLowBalance(accountBalances, ruleFor("LOW_BALANCE")),
    ...evaluateBudgetOverrun(reportRows, ruleFor("BUDGET_OVERRUN"), budgetRuleOptions),
    ...evaluateBudgetThreshold(reportRows, ruleFor("BUDGET_THRESHOLD"), budgetRuleOptions),
    ...evaluateUnusualExpense(monthSeries.transactions, ruleFor("UNUSUAL_EXPENSE"), {
      truncated: monthSeries.truncated,
    }),
    ...evaluateStaleIntegration(connections, ruleFor("STALE_INTEGRATION"), { now }),
    ...evaluateOverdueEvent(dueCashflows, ruleFor("OVERDUE_EVENT"), { now }),
    ...evaluateAiBudgetOverrun(aiBudgets, aiSpends, ruleFor("AI_BUDGET_OVERRUN"), { monthKey }),
    ...evaluateAiBudgetThreshold(aiBudgets, aiSpends, ruleFor("AI_BUDGET_THRESHOLD"), { monthKey }),
  ];

  const plan = planAlertChanges(
    existing.map((alert) => ({
      id: alert.id,
      fingerprint: alert.fingerprint,
      status: alert.status,
    })),
    candidates,
  );

  await applyAlertPlan(workspaceId, plan, now);

  const statusById = new Map(existing.map((alert) => [alert.id, alert.status]));
  const resolvedActive = plan.resolves.filter((id) => statusById.get(id) === "ACTIVE").length;
  const activeBefore = existing.filter((alert) => alert.status === "ACTIVE").length;

  return {
    created: plan.creates.length,
    refreshed: plan.refreshes.length,
    reopened: plan.reopens.length,
    resolved: plan.resolves.length,
    active: activeBefore - resolvedActive + plan.creates.length + plan.reopens.length,
  };
}
