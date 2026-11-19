import { Decimal } from "@/generated/prisma/internal/prismaNamespace";
import {
  currentMonthKey,
  formatMonthLabel,
  monthRange,
  parseMonthKey,
} from "@/lib/dates";
import { DEFAULT_CURRENCY } from "@/lib/money";
import {
  describeAlert,
  isAlertVisible,
  type AlertKind,
  type AlertTone,
} from "@/modules/alerts/domain";
import { listAlerts } from "@/modules/alerts/repository";
import { buildBudgetReport, summariseBudgetReport, type BudgetReportTotal } from "@/modules/budget/report";
import {
  countTransactions,
  listAccounts,
  listBudgets,
  listTransactions,
  listTransactionsForSeries,
  sumTransactionsByCurrency,
} from "@/modules/budget/repository";
import { computeTotalsByCurrency, type MonthlyTotals } from "@/modules/budget/totals";
import {
  describeConnectionState,
  isSyncStale,
  type ConnectionState,
  type ConnectionSummary,
} from "@/modules/integrations/domain";
import { listConnections } from "@/modules/integrations/repository";
import type { ModuleKey } from "@/modules/catalog/catalog";
import { countProperties } from "@/modules/real-estate/repository";
import { summarizeUnallocatedCosts, type UnallocatedSummary } from "@/modules/ai-costs/repository";

/**
 * Dashboard queries.
 *
 * The dashboard only reads. It reports three distinct situations without ever
 * substituting one for another:
 * - "no data yet" (nothing has been entered),
 * - "no data this month" (the account exists but the month is empty),
 * - "not connected" / "synchronisation failed" for a provider.
 *
 * Budget tracking reuses the report builder of the budget module, so its figures equal
 * the ones on the budget page; a month without budget exposes an empty list, never a
 * total of zero.
 */

export type DashboardBudgetSummary = {
  accountCount: number;
  /** Total number of transactions, used to tell "empty account" from "empty month". */
  transactionCount: number;
  monthTransactionCount: number;
  monthTotals: MonthlyTotals[];
  totalCumulative: Decimal;
};

export type DashboardBudgetTracking = {
  /** One total per (currency, kind) of the month's budgets; empty when none is defined. */
  totals: BudgetReportTotal[];
  /** True when the month's transaction read hit its bound: the actuals may be understated. */
  truncated: boolean;
};

export type DashboardIntegrationSummary = {
  connection: ConnectionSummary;
  state: ConnectionState;
  /** True when the last successful synchronisation is older than the displayed threshold. */
  stale: boolean;
};

/** One open alert, as the dashboard banner shows it: explained, never forged. */
export type DashboardAlert = {
  id: string;
  kind: AlertKind;
  title: string;
  reason: string;
  tone: AlertTone;
  triggeredAt: Date;
};

/**
 * A section is `null` when its module is not active in the workspace: nothing was read
 * for it, which is not the same as an empty section.
 */
export type DashboardOverview = {
  monthKey: string;
  monthLabel: string;
  budget: DashboardBudgetSummary | null;
  /** Planned versus actual totals of the month's budgets, the "Suivi" figures. */
  budgetTracking: DashboardBudgetTracking | null;
  realEstate: { propertyCount: number } | null;
  integrations: DashboardIntegrationSummary[] | null;
  /** Cost totals per currency, "not yet allocated" stated explicitly (M9-06). */
  aiCosts: UnallocatedSummary[] | null;
  /** Open alerts of the active modules, read from the stored episodes (the page refreshes them). */
  alerts: { active: DashboardAlert[] };
};

export async function getDashboardOverview(
  workspaceId: string,
  options: { modules: readonly ModuleKey[]; now?: Date },
): Promise<DashboardOverview> {
  const now = options.now ?? new Date();
  const monthKey = currentMonthKey(now);
  const { year, month } = parseMonthKey(monthKey);
  const range = monthRange(year, month);
  // An inactive module's repositories are not even called.
  const read = <T>(key: ModuleKey, query: () => Promise<T>): Promise<T | null> =>
    options.modules.includes(key) ? query() : Promise.resolve(null);

  const [budgetSections, propertyCount, connections, aiCosts, alerts] = await Promise.all([
    read("budget", () => readBudgetSections(workspaceId, { year, month, range })),
    read("real-estate", () => countProperties(workspaceId)),
    read("development", () => listConnections(workspaceId)),
    read("ai-costs", () => summarizeUnallocatedCosts(workspaceId)),
    // The stored episodes: the page runs the evaluation pass before this read, so the
    // banner shows what the engine just found, not what it found last time.
    listAlerts(workspaceId),
  ]);

  return {
    monthKey,
    monthLabel: formatMonthLabel(year, month),
    ...(budgetSections ?? { budget: null, budgetTracking: null }),
    realEstate: propertyCount === null ? null : { propertyCount },
    aiCosts,
    integrations:
      connections?.map((connection) => ({
        connection,
        state: describeConnectionState({
          status: connection.status,
          lastSyncedAt: connection.lastSyncedAt,
          lastSyncError: connection.lastSyncError,
          projectCount: connection.projectCount,
        }),
        stale:
          connection.lastSyncedAt !== null && isSyncStale(connection.lastSyncedAt, now),
      })) ?? null,
    alerts: {
      active: alerts
        .filter((alert) => alert.status === "ACTIVE" && isAlertVisible(alert.kind, options.modules))
        .map((alert) => ({
          id: alert.id,
          kind: alert.kind,
          triggeredAt: alert.triggeredAt,
          ...describeAlert({ kind: alert.kind, inputs: alert.inputs }),
        })),
    },
  };
}

async function readBudgetSections(
  workspaceId: string,
  { year, month, range }: { year: number; month: number; range: ReturnType<typeof monthRange> },
): Promise<{ budget: DashboardBudgetSummary; budgetTracking: DashboardBudgetTracking }> {
  const [monthTransactions, transactionCount, accounts, monthBudgets, monthSeries, cumulativeByCurrency] =
    await Promise.all([
      listTransactions(workspaceId, { from: range.start, to: range.end }),
      countTransactions(workspaceId),
      listAccounts(workspaceId),
      listBudgets(workspaceId, { year, month }),
      // The same read as the 'Suivi' tab, so both screens compare the budgets to the same
      // transactions; reaching the bound is reported through `truncated`.
      listTransactionsForSeries(workspaceId, { from: range.start, to: range.end }),
      // The all-time signed total, aggregated in the database: reading rows to add them up
      // would stop at the page bound and call a truncated sum "the balance".
      sumTransactionsByCurrency(workspaceId),
    ]);

  const budgetTotals = summariseBudgetReport(
    buildBudgetReport(monthBudgets, monthSeries.transactions),
  );

  return {
    budget: {
      accountCount: accounts.length,
      transactionCount,
      monthTransactionCount: monthTransactions.length,
      monthTotals: computeTotalsByCurrency(monthTransactions),
      totalCumulative:
        cumulativeByCurrency.get(DEFAULT_CURRENCY) ?? new Decimal(0),
    },
    budgetTracking: {
      totals: budgetTotals,
      truncated: monthSeries.truncated,
    },
  };
}
