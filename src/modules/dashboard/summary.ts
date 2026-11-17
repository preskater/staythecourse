import Decimal from "decimal.js";
import { EXPORT_ROW_LIMIT } from "@/lib/csv";
import {
  currentMonthKey,
  formatMonthLabel,
  isValidMonthKey,
  monthKeysFrom,
  monthRange,
  parseMonthKey,
  shiftMonthKey,
  toDateOnlyString,
} from "@/lib/dates";
import { publicEnv } from "@/lib/env";
import { DEFAULT_CURRENCY, type Currency } from "@/lib/money";
import {
  ALERT_KIND_MODULES,
  describeAlert,
  isAlertVisible,
  type AlertKind,
} from "@/modules/alerts/domain";
import { listAlerts } from "@/modules/alerts/repository";
import type { AccountType, TransactionRecord } from "@/modules/budget/domain";
import { computeGoalProgress, type GoalProgress, type GoalStatus } from "@/modules/budget/goals";
import { buildSimulatedBalances } from "@/modules/budget/projection";
import {
  plannedOccurrences,
  signedForecastAmount,
  summariseForecastMonth,
  type ForecastContribution,
  type ForecastMonthTotal,
  type ForecastType,
  type RecurrenceFrequency,
  type RecurringEntryRecord,
  type RecurringOccurrenceStatus,
} from "@/modules/budget/recurrence";
import {
  buildBudgetReport,
  summariseBudgetReport,
  type BudgetReportRow,
  type BudgetReportTotal,
} from "@/modules/budget/report";
import {
  findSalarySetting,
  findTransactionByExternalRef,
  listAccountBalanceTotals,
  listAccounts,
  listBudgets,
  listGoals,
  listRecurringEntries,
  listRecurringOccurrences,
  listSalaryRates,
  listTransactions,
  listTransactionsForSeries,
  listWorkDays,
  readAccountBalance,
  sumGoalContributions,
  sumTransactionsByCurrency,
} from "@/modules/budget/repository";
import {
  computeSalarySummary,
  resolveSalaryRate,
  salaryBookingRef,
  salaryEquivalents,
  salaryMonthContribution,
  type SalarySettingRecord,
  type WorkDayRecord,
} from "@/modules/budget/salary";
import {
  buildSavingsThresholds,
  SAVINGS_THRESHOLD_MONTHS,
  type SavingsThreshold,
} from "@/modules/budget/savings";
import { computeMonthlyTotals, type MonthlyTotals } from "@/modules/budget/totals";
import type { ModuleKey } from "@/modules/catalog/catalog";
import {
  describeConnectionState,
  type IntegrationProvider,
} from "@/modules/integrations/domain";
import { listConnections } from "@/modules/integrations/repository";
import type { ActiveWorkspace, WorkspaceKind } from "@/modules/identity/workspace";
import type { BillingModel, ProjectStatus } from "@/modules/micro-business/domain";
import { listProjects, listRevenueDocuments } from "@/modules/micro-business/repository";
import { statementOf, type RevenueStatus } from "@/modules/micro-business/revenue";
import type { CashflowKind, PropertyOccupancy } from "@/modules/real-estate/domain";
import type { LoanSummary } from "@/modules/real-estate/loans";
import { listDueCashflows, listLoans, listProperties } from "@/modules/real-estate/repository";

/**
 * The "situation summary" export: one Markdown document describing where the owner
 * stands, meant to be read by a person or handed to an assistant.
 *
 * It is a **read-only composition**, not a new source of truth: every figure comes from
 * the same pure functions the screens use (`summariseForecastMonth`, `buildBudgetReport`,
 * `computeGoalProgress`, `buildSavingsThresholds`, `buildSimulatedBalances`,
 * `statementOf`), so the document cannot disagree with the interface. This module only
 * reads and arranges; the wording lives in `summary-markdown.ts`.
 *
 * Two rules shape what is read:
 *
 * - **Nothing is written.** The Prévisions tab materialises its occurrences when opened;
 *   the summary must not, because an export is not a visit. The planned dates are
 *   recomputed from the series (`plannedOccurrences`, the function materialisation uses)
 *   and matched with the stored occurrences for their decision; a date without a stored
 *   row is `PENDING`, which is exactly what a materialisation would have written.
 * - **An inactive module is not read.** Its section is reported as unavailable with the
 *   reason, never as an empty one: "module inactif" and "aucune donnée" are two
 *   different statements.
 *
 * Memory follows the export rule: bounded reads, and a table that hit its bound is
 * listed in `truncated` so the document can say it is a prefix.
 */

export const SUMMARY_SCOPES = ["all", "finance"] as const;
export type SummaryScope = (typeof SUMMARY_SCOPES)[number];

export const SUMMARY_HORIZON_DEFAULT = 6;
export const SUMMARY_HORIZON_MAX = 12;

/** Rows per list section: enough to be useful, small enough to stay readable. */
export const SUMMARY_TABLE_LIMIT = 200;

/** The month's transactions feed the actuals and the budget report, so they use the export bound. */
const TRANSACTION_READ_LIMIT = EXPORT_ROW_LIMIT + 1;

export const SUMMARY_SECTIONS = [
  "accounts",
  "actuals",
  "budgets",
  "series",
  "forecast",
  "salary",
  "schedule",
  "savings",
  "goals",
  "properties",
  "loans",
  "propertyDue",
  "projects",
  "invoices",
  "integrations",
  "alerts",
] as const;

export type SummarySectionKey = (typeof SUMMARY_SECTIONS)[number];

export const SUMMARY_SECTION_TITLES: Record<SummarySectionKey, string> = {
  accounts: "Comptes",
  actuals: "Réalisé du mois de référence",
  budgets: "Budgets et suivi du mois de référence",
  series: "Séries récurrentes",
  forecast: "Prévisions du mois de référence",
  salary: "Salaire simulé et enregistré",
  schedule: "Échéancier des mois à venir",
  savings: "Épargne de précaution",
  goals: "Objectifs",
  properties: "Biens immobiliers",
  loans: "Crédits immobiliers",
  propertyDue: "Échéances immobilières non réglées",
  projects: "Projets de la micro-entreprise",
  invoices: "Facturation de la micro-entreprise",
  integrations: "Intégrations",
  alerts: "Alertes actives",
};

/** The module a section belongs to, or `null` for alerts (module-filtered). */
const SECTION_MODULES: Record<SummarySectionKey, ModuleKey | null> = {
  accounts: "budget",
  actuals: "budget",
  budgets: "budget",
  series: "budget",
  forecast: "budget",
  salary: "budget",
  schedule: "budget",
  savings: "budget",
  goals: "budget",
  properties: "real-estate",
  loans: "real-estate",
  propertyDue: "real-estate",
  projects: "micro-business",
  invoices: "micro-business",
  integrations: "development",
  alerts: null,
};

/**
 * A malformed explicit parameter.
 *
 * Refused rather than replaced: a document that silently describes another perimeter
 * would be worse than no document. `month` is the exception, like in the budgets export:
 * a link with a typo falls back to the current month, because the document states its
 * resolved month in its metadata.
 */
export class SummaryFilterError extends Error {
  constructor(
    readonly parameter: "scope" | "horizon",
    readonly code: "invalid_scope" | "invalid_horizon",
  ) {
    super(
      code === "invalid_scope"
        ? "`scope` must be one of the supported values."
        : `\`horizon\` must be an integer between 1 and ${SUMMARY_HORIZON_MAX}.`,
    );
    this.name = "SummaryFilterError";
  }
}

export type SummaryParams = {
  scope: SummaryScope;
  /** Reference month, `YYYY-MM`; a malformed value falls back to the current month. */
  monthKey: string;
  /** How many months after the reference month the schedule covers. */
  horizon: number;
};

/** Reads and validates the query string of `/api/export/summary`. */
export function parseSummaryParams(
  params: URLSearchParams,
  now: Date = new Date(),
): SummaryParams {
  const rawScope = params.get("scope");
  const scope =
    rawScope === null || rawScope === ""
      ? "all"
      : SUMMARY_SCOPES.find((value) => value === rawScope);

  if (!scope) {
    throw new SummaryFilterError("scope", "invalid_scope");
  }

  const rawHorizon = params.get("horizon");
  let horizon = SUMMARY_HORIZON_DEFAULT;

  if (rawHorizon !== null && rawHorizon !== "") {
    const parsed = Number(rawHorizon);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > SUMMARY_HORIZON_MAX) {
      throw new SummaryFilterError("horizon", "invalid_horizon");
    }
    horizon = parsed;
  }

  const rawMonth = params.get("month");

  return {
    scope,
    monthKey: isValidMonthKey(rawMonth) ? rawMonth : currentMonthKey(now),
    horizon,
  };
}

/** One section of the document, and why it is or is not there. */
export type SummarySection = {
  key: SummarySectionKey;
  title: string;
  included: boolean;
  /** `null` when included; otherwise the reason an assistant must not invent figures for. */
  reason: string | null;
};

export type SummaryAccount = {
  name: string;
  type: AccountType;
  currency: Currency;
  /** `null` when nothing was recorded: unknown, never zero. */
  balance: Decimal | null;
  lastOperationOn: Date | null;
};

export type SummaryAccountTotal = {
  currency: Currency;
  balance: Decimal;
  /** Accounts of that currency with a recorded balance; zero means the total is unknown. */
  knownAccounts: number;
  /** Accounts of that currency with nothing recorded: their balance is left out. */
  unknownAccounts: number;
};

export type SummarySeries = {
  label: string;
  type: ForecastType;
  amount: Decimal;
  currency: Currency;
  frequency: RecurrenceFrequency;
  accountName: string;
  categoryName: string | null;
  startDate: Date;
  endDate: Date | null;
};

export type SummaryMovement = {
  date: Date;
  label: string;
  type: ForecastType;
  /** Signed: an expense is negative. */
  amount: Decimal;
  currency: Currency;
  status: RecurringOccurrenceStatus;
  source: "SERIES" | "SALARY";
};

export type SummarySalaryMonth = {
  monthKey: string;
  hourlyRate: Decimal | null;
  currency: Currency | null;
  /** False when no day was ever clicked: an empty calendar is not a zero-hour plan. */
  hasCalendar: boolean;
  plannedHours: Decimal;
  workedHours: Decimal;
  totalHours: Decimal;
  /** Hours × rate, or `null` when no rate covers the month. */
  simulatedAmount: Decimal | null;
  booked: boolean;
  bookedAmount: Decimal | null;
};

export type SummarySalary = {
  /** Day length used by the calendar; `null` when no setting was recorded. */
  hoursPerDay: Decimal | null;
  currency: Currency | null;
  /**
   * Indicative day/week/month equivalents of the reference month's rate, computed from
   * the configured day length and a five-day week. Never stored, never a payslip: they
   * are what the schedule entered would earn at that rate.
   */
  equivalents: { daily: Decimal; weekly: Decimal; monthly: Decimal } | null;
  months: SummarySalaryMonth[];
};

export type SummaryScheduleMonth = {
  monthKey: string;
  totals: ForecastMonthTotal[];
  /** Simulated end-of-month balance per currency; empty when nothing was ever recorded. */
  balances: { currency: Currency; balance: Decimal }[];
};

export type SummaryGoal = {
  name: string;
  currency: Currency;
  targetAmount: Decimal;
  targetDate: Date;
  status: GoalStatus;
  progress: GoalProgress;
};

export type SummaryFinance = {
  accounts: SummaryAccount[];
  accountTotals: SummaryAccountTotal[];
  series: SummarySeries[];
  reference: {
    monthKey: string;
    /** Recorded operations of the month, per currency. */
    actuals: MonthlyTotals[];
    budgets: { lines: BudgetReportRow[]; totals: BudgetReportTotal[] };
    pending: SummaryMovement[];
    totals: ForecastMonthTotal[];
  };
  salary: SummarySalary;
  schedule: SummaryScheduleMonth[];
  savings: SavingsThreshold[];
  goals: SummaryGoal[];
};

export type SummaryProperty = {
  name: string;
  /** How many cashflow entries exist: zero is a fact, not a missing value. */
  cashflowCount: number;
  address: string | null;
  occupancy: PropertyOccupancy;
  purchaseDate: Date | null;
  purchasePrice: Decimal | null;
  currency: Currency;
  estimatedValue: Decimal | null;
  estimatedValueAsOf: Date | null;
  /** Operating totals of one currency, from the recorded cashflows. */
  income: Decimal;
  expenses: Decimal;
  net: Decimal;
  /** Cashflow entries in another currency, excluded from the totals instead of converted. */
  foreignCurrencyCashflows: number;
  notes: string | null;
};

export type SummaryLoan = {
  propertyName: string;
  label: string;
  currency: Currency;
  initialPrincipal: Decimal;
  outstandingBalance: Decimal | null;
  interestRate: Decimal | null;
  paymentAmount: Decimal | null;
  insuranceAmount: Decimal | null;
  endDate: Date | null;
};

export type SummaryPropertyDue = {
  propertyName: string;
  label: string;
  kind: CashflowKind;
  amount: Decimal | null;
  currency: Currency;
  dueDate: Date | null;
};

export type SummaryRealEstate = {
  properties: SummaryProperty[];
  loans: SummaryLoan[];
  due: SummaryPropertyDue[];
};

export type SummaryProject = {
  name: string;
  clientName: string | null;
  billingModel: BillingModel;
  status: ProjectStatus;
  currency: Currency;
  startDate: Date | null;
  endDate: Date | null;
};

export type SummaryInvoice = {
  clientName: string | null;
  projectName: string;
  currency: Currency;
  amount: Decimal;
  netIssued: Decimal;
  paid: Decimal;
  outstanding: Decimal;
  issuedOn: Date;
  dueOn: Date | null;
  status: RevenueStatus;
  overdueDays: number;
};

export type SummaryMicroBusiness = {
  projects: SummaryProject[];
  invoices: SummaryInvoice[];
  /** Outstanding receivables per currency, invoices only. */
  outstandingTotals: { currency: Currency; amount: Decimal }[];
};

export type SummaryIntegration = {
  provider: IntegrationProvider;
  instance: string;
  state: ReturnType<typeof describeConnectionState>["kind"];
  lastSyncedAt: Date | null;
  projectCount: number;
  issueCount: number;
  milestoneCount: number;
};

export type SummaryAlert = {
  kind: AlertKind;
  triggeredAt: Date;
  title: string;
  reason: string;
};

export type SituationSummary = {
  generatedAt: Date;
  scope: SummaryScope;
  monthKey: string;
  monthLabel: string;
  horizon: number;
  /** Months covered by the schedule, first to last, excluding the reference month. */
  horizonKeys: string[];
  workspace: { name: string; kind: WorkspaceKind };
  defaultCurrency: string;
  timeZone: string;
  modules: readonly ModuleKey[];
  sections: SummarySection[];
  /** Sections whose table hit its read bound: the document says it is a prefix. */
  truncated: SummarySectionKey[];
  finance: SummaryFinance | null;
  realEstate: SummaryRealEstate | null;
  microBusiness: SummaryMicroBusiness | null;
  integrations: SummaryIntegration[] | null;
  alerts: SummaryAlert[];
};

/** Splits a bounded read and records the section when it was cut. */
function bound<Row>(
  rows: readonly Row[],
  section: SummarySectionKey,
  truncated: SummarySectionKey[],
  limit: number = SUMMARY_TABLE_LIMIT,
): Row[] {
  if (rows.length <= limit) {
    return [...rows];
  }

  truncated.push(section);
  return rows.slice(0, limit);
}

/** The month of a date-only row, `YYYY-MM`. */
function monthKeyOf(day: Date): string {
  return toDateOnlyString(day).slice(0, 7);
}

/** The rate input `salaryMonthContribution` expects, or `null` when the month has no rate. */
function salaryRateInput(
  setting: SalarySettingRecord | null,
  hourlyRate: Decimal | null,
): { hourlyRate: Decimal; currency: Currency } | null {
  return setting && hourlyRate ? { hourlyRate, currency: setting.currency } : null;
}

/**
 * The planned dates of one month's series, with the decision already taken.
 *
 * A stored occurrence, when it exists, tells what the owner decided; a date without one
 * is `PENDING`, which is what the Prévisions tab would materialise. Reading the series
 * instead of the occurrence rows is what lets this export stay read-only.
 */
function monthContributions(
  entries: readonly RecurringEntryRecord[],
  currencyByAccount: ReadonlyMap<string, Currency>,
  statusByDate: ReadonlyMap<string, RecurringOccurrenceStatus>,
  monthKey: string,
): { contributions: ForecastContribution[]; pending: SummaryMovement[] } {
  const { year, month } = parseMonthKey(monthKey);
  const contributions: ForecastContribution[] = [];
  const pending: SummaryMovement[] = [];
  const entriesById = new Map(entries.map((entry) => [entry.id, entry]));

  for (const occurrence of plannedOccurrences(entries, year, month)) {
    const entry = entriesById.get(occurrence.recurringId);
    if (!entry) {
      continue;
    }

    const currency = currencyByAccount.get(entry.accountId) ?? DEFAULT_CURRENCY;
    const status =
      statusByDate.get(`${entry.id}|${toDateOnlyString(occurrence.date)}`) ?? "PENDING";
    contributions.push({ currency, type: entry.type, amount: entry.amount, status });

    if (status === "PENDING") {
      pending.push({
        date: occurrence.date,
        label: entry.label,
        type: entry.type,
        amount: signedForecastAmount(entry.type, entry.amount),
        currency,
        status,
        source: "SERIES",
      });
    }
  }

  return { contributions, pending };
}

/** Recorded operations of one window, aggregated per currency. */
function totalsByCurrency(transactions: readonly TransactionRecord[]): MonthlyTotals[] {
  const byCurrency = new Map<Currency, TransactionRecord[]>();

  for (const transaction of transactions) {
    const bucket = byCurrency.get(transaction.currency);

    if (bucket) {
      bucket.push(transaction);
    } else {
      byCurrency.set(transaction.currency, [transaction]);
    }
  }

  return [...byCurrency.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, rows]) => computeMonthlyTotals(rows, { currency }));
}

/**
 * The finance block: what is recorded, what is planned, and what is simulated.
 *
 * Reads only the budget module's tables; the caller checks that the module is active.
 */
async function readFinance(
  workspaceId: string,
  input: { monthKey: string; horizonKeys: string[]; now: Date; truncated: SummarySectionKey[] },
): Promise<SummaryFinance> {
  const { monthKey, horizonKeys, now, truncated } = input;
  const { year, month } = parseMonthKey(monthKey);
  const range = monthRange(year, month);
  const firstHorizon = parseMonthKey(horizonKeys[0]);
  const lastHorizon = parseMonthKey(horizonKeys[horizonKeys.length - 1]);
  const horizonStart = monthRange(firstHorizon.year, firstHorizon.month).start;
  const horizonEnd = monthRange(lastHorizon.year, lastHorizon.month).end;
  const salaryMonths = [monthKey, ...horizonKeys];

  const [
    accounts,
    balanceTotals,
    monthTransactions,
    budgets,
    entries,
    occurrences,
    salarySetting,
    rates,
    workDays,
    bookings,
    goals,
    contributionSums,
    recordedBefore,
    horizonRecorded,
  ] = await Promise.all([
    listAccounts(workspaceId),
    listAccountBalanceTotals(workspaceId),
    listTransactions(workspaceId, {
      from: range.start,
      to: range.end,
      take: TRANSACTION_READ_LIMIT,
    }),
    listBudgets(workspaceId, { year, month }),
    listRecurringEntries(workspaceId),
    // The decisions of the whole window, reference month included: a confirmed or
    // skipped occurrence must not be presented as still waiting.
    listRecurringOccurrences(workspaceId, { from: range.start, to: horizonEnd }),
    findSalarySetting(workspaceId),
    listSalaryRates(workspaceId),
    listWorkDays(workspaceId, { from: range.start, to: horizonEnd }),
    // One indexed lookup per month through the stable `salary:YYYY-MM` reference, the
    // same read the Prévisions tab performs for its scheduler.
    Promise.all(
      salaryMonths.map((key) => {
        const parsed = parseMonthKey(key);
        return findTransactionByExternalRef(
          workspaceId,
          salaryBookingRef(parsed.year, parsed.month),
        );
      }),
    ),
    listGoals(workspaceId, { take: SUMMARY_TABLE_LIMIT + 1 }),
    sumGoalContributions(workspaceId),
    sumTransactionsByCurrency(workspaceId, { before: horizonStart }),
    listTransactionsForSeries(workspaceId, { from: horizonStart, to: horizonEnd }),
  ]);

  const currencyByAccount = new Map(accounts.map((account) => [account.id, account.currency]));
  const balanceByAccount = new Map(balanceTotals.map((total) => [total.accountId, total]));

  const summaryAccounts: SummaryAccount[] = accounts.map((account) => {
    const total = balanceByAccount.get(account.id);

    return {
      name: account.name,
      type: account.type as AccountType,
      currency: account.currency,
      balance: total && total.transactionCount > 0 ? total.balance : null,
      lastOperationOn: total?.lastOperationDate ?? null,
    };
  });

  const accountTotals = new Map<Currency, SummaryAccountTotal>();

  for (const account of summaryAccounts) {
    const bucket = accountTotals.get(account.currency) ?? {
      currency: account.currency,
      balance: new Decimal(0),
      knownAccounts: 0,
      unknownAccounts: 0,
    };

    if (account.balance === null) {
      bucket.unknownAccounts += 1;
    } else {
      bucket.balance = bucket.balance.plus(account.balance);
      bucket.knownAccounts += 1;
    }

    accountTotals.set(account.currency, bucket);
  }

  const statusByDate = new Map<string, RecurringOccurrenceStatus>(
    occurrences.map((occurrence) => [
      `${occurrence.recurringId}|${toDateOnlyString(occurrence.date)}`,
      occurrence.status,
    ]),
  );

  const series: SummarySeries[] = entries.map((entry) => ({
    label: entry.label,
    type: entry.type,
    amount: entry.amount,
    currency: currencyByAccount.get(entry.accountId) ?? DEFAULT_CURRENCY,
    frequency: entry.frequency,
    accountName: entry.accountName,
    categoryName: entry.categoryName,
    startDate: entry.startDate,
    endDate: entry.endDate,
  }));

  const referenceSeries = monthContributions(entries, currencyByAccount, statusByDate, monthKey);

  // Salary per month: the rate in force applies from its change point, the clicked days
  // give the hours, and the booking — when it exists — is the amount that really landed.
  const workDaysByMonth = new Map<string, WorkDayRecord[]>();

  for (const day of workDays) {
    const key = monthKeyOf(day.date);
    const bucket = workDaysByMonth.get(key);

    if (bucket) {
      bucket.push(day);
    } else {
      workDaysByMonth.set(key, [day]);
    }
  }

  const salaryCurrency = salarySetting?.currency ?? null;

  const salaryMonthRows: SummarySalaryMonth[] = salaryMonths.map((key, index) => {
    const parsed = parseMonthKey(key);
    const rate = resolveSalaryRate(rates, parsed.year, parsed.month);
    const days = workDaysByMonth.get(key) ?? [];
    const booking = bookings[index];
    const simulated = rate && days.length > 0 ? computeSalarySummary(days, rate.hourlyRate) : null;

    return {
      monthKey: key,
      hourlyRate: rate?.hourlyRate ?? null,
      currency: salaryCurrency,
      hasCalendar: days.length > 0,
      plannedHours: simulated?.plannedHours ?? new Decimal(0),
      workedHours: simulated?.workedHours ?? new Decimal(0),
      totalHours: simulated?.totalHours ?? new Decimal(0),
      simulatedAmount: simulated?.totalAmount ?? null,
      booked: booking !== null,
      bookedAmount: booking?.amount ?? null,
    };
  });

  const referenceSalaryDays = workDaysByMonth.get(monthKey) ?? [];
  const referenceSalaryDay = referenceSalaryDays.at(-1) ?? null;
  const referenceSalaryContribution = salaryMonthContribution({
    rate: salaryRateInput(salarySetting, salaryMonthRows[0].hourlyRate),
    days: referenceSalaryDays,
    booking: bookings[0] ?? null,
  });

  const referencePending = [...referenceSeries.pending];

  if (referenceSalaryContribution?.status === "PENDING" && referenceSalaryDay) {
    referencePending.push({
      date: referenceSalaryDay.date,
      label: "Salaire simulé",
      type: "INCOME",
      amount: referenceSalaryContribution.amount,
      currency: referenceSalaryContribution.currency,
      status: "PENDING",
      source: "SALARY",
    });
  }

  const referenceContributions: ForecastContribution[] = [...referenceSeries.contributions];

  if (referenceSalaryContribution) {
    referenceContributions.push(referenceSalaryContribution);
  }

  // The schedule: the months after the reference one, each completed with its salary
  // (clicked days, or the amount already booked). Recorded operations are bucketed per
  // month so the simulated balance advances with them and never counts them twice.
  const recordedByMonth = new Map<string, Map<Currency, Decimal>>();

  for (const transaction of horizonRecorded.transactions) {
    const key = monthKeyOf(transaction.operationDate);
    const byCurrency = recordedByMonth.get(key) ?? new Map<Currency, Decimal>();
    byCurrency.set(
      transaction.currency,
      (byCurrency.get(transaction.currency) ?? new Decimal(0)).plus(transaction.amount),
    );
    recordedByMonth.set(key, byCurrency);
  }

  const scheduled = horizonKeys.map((key, index) => {
    const monthSeries = monthContributions(entries, currencyByAccount, statusByDate, key);
    const salary = salaryMonthContribution({
      rate: salaryRateInput(salarySetting, salaryMonthRows[index + 1].hourlyRate),
      days: workDaysByMonth.get(key) ?? [],
      booking: bookings[index + 1] ?? null,
    });

    return {
      key,
      contributions: salary ? [...monthSeries.contributions, salary] : monthSeries.contributions,
    };
  });

  const simulated = buildSimulatedBalances({
    recordedBefore,
    months: scheduled.map((month) => ({
      key: month.key,
      recorded: recordedByMonth.get(month.key) ?? new Map<Currency, Decimal>(),
      pending: month.contributions
        .filter((contribution) => contribution.status === "PENDING")
        .reduce((map, contribution) => {
          const signed = signedForecastAmount(contribution.type, contribution.amount);
          map.set(
            contribution.currency,
            (map.get(contribution.currency) ?? new Decimal(0)).plus(signed),
          );
          return map;
        }, new Map<Currency, Decimal>()),
    })),
  });

  if (horizonRecorded.truncated) {
    truncated.push("schedule");
  }

  const schedule: SummaryScheduleMonth[] = scheduled.map((month, index) => ({
    monthKey: month.key,
    totals: summariseForecastMonth(month.contributions),
    balances: [...simulated[index].balances.entries()]
      .map(([currency, balance]) => ({ currency, balance }))
      .sort((left, right) => left.currency.localeCompare(right.currency)),
  }));

  // Savings cushion: the reference month and the five after it, the same six-month rule
  // the budget page applies, resolved from the series and never stored.
  const savingsAccounts = accounts
    .filter((account) => account.type === "SAVINGS")
    .map((account) => {
      const total = balanceByAccount.get(account.id);

      return {
        accountId: account.id,
        accountName: account.name,
        currency: account.currency,
        transactionCount: total?.transactionCount ?? 0,
        balance: total?.balance ?? new Decimal(0),
      };
    });

  const savings = buildSavingsThresholds({
    entries,
    currencyByAccount,
    savingsAccounts,
    months: monthKeysFrom(monthKey, SAVINGS_THRESHOLD_MONTHS),
  });

  // Goal progress reads the recorded balance of a linked account, so the document matches
  // the goals tab exactly — including "unknown", which is never rendered as zero.
  const goalAccountIds = [
    ...new Set(goals.flatMap((goal) => (goal.accountId === null ? [] : [goal.accountId]))),
  ];
  const goalBalances = new Map(
    await Promise.all(
      goalAccountIds.map(async (accountId) => {
        const { transactionCount, balance } = await readAccountBalance(workspaceId, accountId);
        return [accountId, transactionCount === 0 ? null : balance] as const;
      }),
    ),
  );

  // One slice for both the actuals and the budget report: a truncated month must not
  // compare a budget with one more operation than the totals above it.
  const monthRows = monthTransactions.slice(0, EXPORT_ROW_LIMIT);
  const budgetLines = buildBudgetReport(budgets, monthRows);

  if (monthTransactions.length > EXPORT_ROW_LIMIT) {
    truncated.push("actuals", "budgets");
  }

  return {
    accounts: summaryAccounts,
    accountTotals: [...accountTotals.values()].sort((left, right) =>
      left.currency.localeCompare(right.currency),
    ),
    series: bound(series, "series", truncated),
    reference: {
      monthKey,
      actuals: totalsByCurrency(monthRows),
      budgets: { lines: budgetLines, totals: summariseBudgetReport(budgetLines) },
      pending: bound(referencePending, "forecast", truncated),
      totals: summariseForecastMonth(referenceContributions),
    },
    salary: {
      hoursPerDay: salarySetting?.hoursPerDay ?? null,
      currency: salaryCurrency,
      equivalents:
        salarySetting && salaryMonthRows[0].hourlyRate
          ? salaryEquivalents(salaryMonthRows[0].hourlyRate, salarySetting.hoursPerDay)
          : null,
      months: salaryMonthRows,
    },
    schedule,
    savings,
    goals: bound(goals, "goals", truncated).map((goal) => ({
      name: goal.name,
      currency: goal.currency,
      targetAmount: goal.targetAmount,
      targetDate: goal.targetDate,
      status: goal.status,
      progress: computeGoalProgress(
        goal,
        goal.accountId === null ? null : (goalBalances.get(goal.accountId) ?? null),
        { now, contributionSum: contributionSums.get(goal.id)?.total ?? null },
      ),
    })),
  };
}

/** The real-estate block: the assets, their financing and what is still owed to them. */
async function readRealEstate(
  workspaceId: string,
  input: { horizonEndDay: Date; truncated: SummarySectionKey[] },
): Promise<SummaryRealEstate> {
  const [properties, loans, due] = await Promise.all([
    listProperties(workspaceId, { take: SUMMARY_TABLE_LIMIT + 1 }),
    listLoans(workspaceId),
    listDueCashflows(workspaceId, { until: input.horizonEndDay }),
  ]);

  const propertyNames = new Map(properties.map((property) => [property.id, property.name]));

  return {
    properties: bound(
      properties.map((property) => ({
        name: property.name,
        cashflowCount: property.cashflowCount,
        address: property.address,
        occupancy: property.occupancy,
        purchaseDate: property.purchaseDate,
        purchasePrice: property.purchasePrice,
        currency: property.currency,
        estimatedValue: property.estimatedValue,
        estimatedValueAsOf: property.estimatedValueAsOf,
        income: property.income,
        expenses: property.expenses,
        net: property.net,
        foreignCurrencyCashflows: property.foreignCurrencyCashflows,
        notes: property.notes,
      })),
      "properties",
      input.truncated,
    ),
    loans: bound(
      loans.map((loan: LoanSummary) => ({
        propertyName: propertyNames.get(loan.propertyId) ?? "Bien inconnu",
        label: loan.label,
        currency: loan.currency,
        initialPrincipal: loan.initialPrincipal,
        outstandingBalance: loan.outstandingBalance,
        interestRate: loan.interestRate,
        paymentAmount: loan.paymentAmount,
        insuranceAmount: loan.insuranceAmount,
        endDate: loan.endDate,
      })),
      "loans",
      input.truncated,
    ),
    due: bound(
      due.map((entry) => ({
        propertyName: entry.propertyName,
        label: entry.label,
        kind: entry.kind,
        amount: entry.amount,
        currency: entry.currency,
        dueDate: entry.dueDate,
      })),
      "propertyDue",
      input.truncated,
    ),
  };
}

/** The micro-business block: what is in progress and what is still to be collected. */
async function readMicroBusiness(
  workspaceId: string,
  input: { now: Date; truncated: SummarySectionKey[] },
): Promise<SummaryMicroBusiness> {
  const [projects, documents] = await Promise.all([
    listProjects(workspaceId),
    listRevenueDocuments(workspaceId),
  ]);

  const invoices: SummaryInvoice[] = [];

  for (const document of documents) {
    if (document.kind !== "INVOICE") {
      continue;
    }

    const statement = statementOf(document, input.now);

    // Only what is still open: a settled invoice adds no receivable, and this document is
    // a situation summary, not an accounting export.
    if (!statement.outstanding.greaterThan(0)) {
      continue;
    }

    invoices.push({
      clientName: document.clientName,
      projectName: document.projectName,
      currency: statement.currency,
      amount: statement.amount,
      netIssued: statement.netIssued,
      paid: statement.paid,
      outstanding: statement.outstanding,
      issuedOn: document.issuedOn,
      dueOn: document.dueOn,
      status: statement.status,
      overdueDays: statement.overdueDays,
    });
  }

  const outstandingTotals = new Map<Currency, Decimal>();

  for (const invoice of invoices) {
    outstandingTotals.set(
      invoice.currency,
      (outstandingTotals.get(invoice.currency) ?? new Decimal(0)).plus(invoice.outstanding),
    );
  }

  return {
    projects: bound(
      projects.map((project) => ({
        name: project.name,
        clientName: project.clientName,
        billingModel: project.billingModel,
        status: project.status,
        currency: project.currency,
        startDate: project.startDate,
        endDate: project.endDate,
      })),
      "projects",
      input.truncated,
    ),
    invoices: bound(invoices, "invoices", input.truncated),
    outstandingTotals: [...outstandingTotals.entries()]
      .map(([currency, amount]) => ({ currency, amount }))
      .sort((left, right) => left.currency.localeCompare(right.currency)),
  };
}

/** Builds the whole document model for one workspace. */
export async function readSituationSummary(input: {
  workspace: ActiveWorkspace;
  params: SummaryParams;
  now?: Date;
}): Promise<SituationSummary> {
  const now = input.now ?? new Date();
  const { workspace, params } = input;
  const { year, month } = parseMonthKey(params.monthKey);
  const horizonKeys = monthKeysFrom(shiftMonthKey(params.monthKey, 1), params.horizon);
  const lastHorizon = parseMonthKey(horizonKeys[horizonKeys.length - 1]);
  const horizonEndDay = new Date(
    monthRange(lastHorizon.year, lastHorizon.month).end.getTime() - 1,
  );
  const truncated: SummarySectionKey[] = [];

  const has = (key: ModuleKey): boolean => workspace.modules.includes(key);
  // `scope=finance` narrows the document to the personal budget: the other modules are
  // reported as excluded rather than read and hidden, so the reader knows what is missing.
  const scoped = (key: ModuleKey): boolean =>
    has(key) && (params.scope === "all" || key === "budget");

  const sections: SummarySection[] = SUMMARY_SECTIONS.map((key) => {
    const requiredModule = SECTION_MODULES[key];

    if (requiredModule === null) {
      return { key, title: SUMMARY_SECTION_TITLES[key], included: true, reason: null };
    }

    if (!has(requiredModule)) {
      return {
        key,
        title: SUMMARY_SECTION_TITLES[key],
        included: false,
        reason: `module « ${requiredModule} » inactif dans cet espace de travail`,
      };
    }

    if (!scoped(requiredModule)) {
      return {
        key,
        title: SUMMARY_SECTION_TITLES[key],
        included: false,
        reason: "exclue par le périmètre demandé (scope=finance)",
      };
    }

    return { key, title: SUMMARY_SECTION_TITLES[key], included: true, reason: null };
  });

  const [finance, realEstate, microBusiness, connections] = await Promise.all([
    scoped("budget")
      ? readFinance(workspace.id, { monthKey: params.monthKey, horizonKeys, now, truncated })
      : Promise.resolve(null),
    scoped("real-estate")
      ? readRealEstate(workspace.id, { horizonEndDay, truncated })
      : Promise.resolve(null),
    scoped("micro-business")
      ? readMicroBusiness(workspace.id, { now, truncated })
      : Promise.resolve(null),
    scoped("development") ? listConnections(workspace.id) : Promise.resolve(null),
  ]);

  // Alerts are module-filtered twice: an inactive module's alert is never shown (like the
  // dashboard banner and the alerts export), and `scope=finance` also drops the ones whose
  // rule reads another module — a budget-only document must not carry a property warning.
  const alerts = await listAlerts(workspace.id, {
    status: "ACTIVE",
    take: SUMMARY_TABLE_LIMIT + 1,
  });

  return {
    generatedAt: now,
    scope: params.scope,
    monthKey: params.monthKey,
    monthLabel: formatMonthLabel(year, month),
    horizon: params.horizon,
    horizonKeys,
    workspace: { name: workspace.name, kind: workspace.kind },
    defaultCurrency: publicEnv.NEXT_PUBLIC_DEFAULT_CURRENCY,
    timeZone: publicEnv.NEXT_PUBLIC_DEFAULT_TIME_ZONE,
    modules: workspace.modules,
    sections,
    truncated,
    finance,
    realEstate,
    microBusiness,
    integrations: connections
      ? bound(
          connections.map((connection) => {
            const state = describeConnectionState(connection);

            return {
              provider: connection.provider,
              instance: connection.instanceUrl,
              state: state.kind,
              lastSyncedAt: connection.lastSyncedAt,
              projectCount: connection.projectCount,
              issueCount: connection.issueCount,
              milestoneCount: connection.milestoneCount,
            };
          }),
          "integrations",
          truncated,
        )
      : null,
    alerts: bound(
      alerts
        .filter(
          (alert) =>
            isAlertVisible(alert.kind, workspace.modules) &&
            scoped(ALERT_KIND_MODULES[alert.kind]),
        )
        .map((alert) => {
          const described = describeAlert({ kind: alert.kind, inputs: alert.inputs });

          return {
            kind: alert.kind,
            triggeredAt: alert.triggeredAt,
            title: described.title,
            reason: described.reason,
          };
        }),
      "alerts",
      truncated,
    ),
  };
}
