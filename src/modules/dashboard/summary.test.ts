import Decimal from "decimal.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActiveWorkspace } from "@/modules/identity/workspace";

/**
 * The situation summary composes the same pure functions as the screens; what these
 * tests pin down is the composition: what is read, what is left alone, and how an
 * unrecorded value or an undecided occurrence is represented. Fictitious data only.
 */

const budgetReads = {
  listAccounts: vi.fn(),
  listAccountBalanceTotals: vi.fn(),
  listTransactions: vi.fn(),
  listBudgets: vi.fn(),
  listRecurringEntries: vi.fn(),
  listRecurringOccurrences: vi.fn(),
  findSalarySetting: vi.fn(),
  listSalaryRates: vi.fn(),
  listWorkDays: vi.fn(),
  findTransactionByExternalRef: vi.fn(),
  listGoals: vi.fn(),
  sumGoalContributions: vi.fn(),
  sumTransactionsByCurrency: vi.fn(),
  listTransactionsForSeries: vi.fn(),
  readAccountBalance: vi.fn(),
};
const listAlertsMock = vi.fn();
const realEstateReads = {
  listProperties: vi.fn(),
  listLoans: vi.fn(),
  listDueCashflows: vi.fn(),
};
const microBusinessReads = {
  listProjects: vi.fn(),
  listRevenueDocuments: vi.fn(),
};
const listConnectionsMock = vi.fn();

vi.mock("@/modules/budget/repository", () => budgetReads);
vi.mock("@/modules/alerts/repository", () => ({ listAlerts: () => listAlertsMock() }));
vi.mock("@/modules/real-estate/repository", () => realEstateReads);
vi.mock("@/modules/micro-business/repository", () => microBusinessReads);
vi.mock("@/modules/integrations/repository", () => ({ listConnections: () => listConnectionsMock() }));

const { parseSummaryParams, readSituationSummary, SummaryFilterError } = await import("./summary");

const NOW = new Date("2026-11-16T08:00:00.000Z");

const ALL_MODULES: ActiveWorkspace = {
  id: "ws-fictitious",
  name: "Espace fictif",
  kind: "PERSONAL",
  role: "OWNER",
  modules: ["budget", "real-estate", "micro-business", "development"],
};

const BUDGET_ONLY: ActiveWorkspace = { ...ALL_MODULES, modules: ["budget"] };

function transaction(overrides: Record<string, unknown> = {}) {
  return {
    id: "tx-1",
    type: "INCOME",
    amount: new Decimal("280.00"),
    currency: "EUR",
    operationDate: new Date("2026-11-30T00:00:00.000Z"),
    label: "Salaire",
    accountId: "account-1",
    accountName: "Compte courant",
    categoryId: null,
    categoryName: null,
    notes: null,
    externalRef: "salary:2026-11",
    transferGroupId: null,
    reconciledAt: null,
    createdAt: new Date("2026-11-30T10:00:00.000Z"),
    ...overrides,
  };
}

function sectionOf(summary: { sections: { key: string; included: boolean; reason: string | null }[] }, key: string) {
  return summary.sections.find((section) => section.key === key);
}

beforeEach(() => {
  vi.clearAllMocks();

  budgetReads.listAccounts.mockResolvedValue([]);
  budgetReads.listAccountBalanceTotals.mockResolvedValue([]);
  budgetReads.listTransactions.mockResolvedValue([]);
  budgetReads.listBudgets.mockResolvedValue([]);
  budgetReads.listRecurringEntries.mockResolvedValue([]);
  budgetReads.listRecurringOccurrences.mockResolvedValue([]);
  budgetReads.findSalarySetting.mockResolvedValue(null);
  budgetReads.listSalaryRates.mockResolvedValue([]);
  budgetReads.listWorkDays.mockResolvedValue([]);
  budgetReads.findTransactionByExternalRef.mockResolvedValue(null);
  budgetReads.listGoals.mockResolvedValue([]);
  budgetReads.sumGoalContributions.mockResolvedValue(new Map());
  budgetReads.sumTransactionsByCurrency.mockResolvedValue(new Map());
  budgetReads.listTransactionsForSeries.mockResolvedValue({ transactions: [], truncated: false });
  budgetReads.readAccountBalance.mockResolvedValue({
    transactionCount: 0,
    balance: new Decimal(0),
  });
  listAlertsMock.mockResolvedValue([]);
  realEstateReads.listProperties.mockResolvedValue([]);
  realEstateReads.listLoans.mockResolvedValue([]);
  realEstateReads.listDueCashflows.mockResolvedValue([]);
  microBusinessReads.listProjects.mockResolvedValue([]);
  microBusinessReads.listRevenueDocuments.mockResolvedValue([]);
  listConnectionsMock.mockResolvedValue([]);
});

describe("parseSummaryParams", () => {
  it("defaults to every module, the current month and a six-month horizon", () => {
    expect(parseSummaryParams(new URLSearchParams(), NOW)).toEqual({
      scope: "all",
      monthKey: "2026-11",
      horizon: 6,
    });
  });

  it("falls back to the current month on a malformed value, like the budgets export", () => {
    expect(parseSummaryParams(new URLSearchParams({ month: "2026-13" }), NOW).monthKey).toBe(
      "2026-11",
    );
  });

  it("refuses an unknown scope and an out-of-range horizon instead of guessing", () => {
    expect(() => parseSummaryParams(new URLSearchParams({ scope: "family" }), NOW)).toThrow(
      SummaryFilterError,
    );
    expect(() => parseSummaryParams(new URLSearchParams({ horizon: "0" }), NOW)).toThrow(
      SummaryFilterError,
    );
    expect(() => parseSummaryParams(new URLSearchParams({ horizon: "13" }), NOW)).toThrow(
      SummaryFilterError,
    );

    try {
      parseSummaryParams(new URLSearchParams({ scope: "family" }), NOW);
    } catch (error) {
      expect(error).toMatchObject({ parameter: "scope", code: "invalid_scope" });
    }
  });
});

describe("readSituationSummary", () => {
  it("reads a module only when it is active, and says why a section is missing", async () => {
    const summary = await readSituationSummary({
      workspace: BUDGET_ONLY,
      params: { scope: "all", monthKey: "2026-11", horizon: 2 },
      now: NOW,
    });

    expect(summary.finance).not.toBeNull();
    expect(summary.realEstate).toBeNull();
    expect(summary.microBusiness).toBeNull();
    expect(sectionOf(summary, "properties")).toMatchObject({
      included: false,
      reason: "module « real-estate » inactif dans cet espace de travail",
    });
    expect(realEstateReads.listProperties).not.toHaveBeenCalled();
    expect(microBusinessReads.listProjects).not.toHaveBeenCalled();
    expect(listConnectionsMock).not.toHaveBeenCalled();
  });

  it("narrows the document to the budget when scope=finance, without reading the rest", async () => {
    const summary = await readSituationSummary({
      workspace: ALL_MODULES,
      params: { scope: "finance", monthKey: "2026-11", horizon: 2 },
      now: NOW,
    });

    expect(summary.finance).not.toBeNull();
    expect(summary.realEstate).toBeNull();
    expect(sectionOf(summary, "invoices")).toMatchObject({
      included: false,
      reason: "exclue par le périmètre demandé (scope=finance)",
    });
    // Alerts are always part of the situation.
    expect(sectionOf(summary, "alerts")).toMatchObject({ included: true, reason: null });
    expect(microBusinessReads.listRevenueDocuments).not.toHaveBeenCalled();
  });

  it("keeps an unrecorded balance unknown and out of the currency total", async () => {
    budgetReads.listAccounts.mockResolvedValue([
      { id: "account-1", name: "Compte courant", type: "CHECKING", currency: "EUR" },
      { id: "account-2", name: "Livret", type: "SAVINGS", currency: "EUR" },
    ]);
    budgetReads.listAccountBalanceTotals.mockResolvedValue([
      {
        accountId: "account-1",
        transactionCount: 3,
        balance: new Decimal("512.40"),
        lastOperationDate: new Date("2026-11-12T00:00:00.000Z"),
      },
    ]);

    const summary = await readSituationSummary({
      workspace: BUDGET_ONLY,
      params: { scope: "finance", monthKey: "2026-11", horizon: 1 },
      now: NOW,
    });

    expect(summary.finance?.accounts).toEqual([
      expect.objectContaining({ name: "Compte courant", balance: new Decimal("512.40") }),
      expect.objectContaining({ name: "Livret", balance: null }),
    ]);
    expect(summary.finance?.accountTotals).toEqual([
      { currency: "EUR", balance: new Decimal("512.40"), knownAccounts: 1, unknownAccounts: 1 },
    ]);
  });

  it("recomputes an undecided occurrence as pending without writing anything", async () => {
    budgetReads.listAccounts.mockResolvedValue([
      { id: "account-1", name: "Compte courant", type: "CHECKING", currency: "EUR" },
    ]);
    budgetReads.listRecurringEntries.mockResolvedValue([
      {
        id: "entry-1",
        accountId: "account-1",
        accountName: "Compte courant",
        categoryId: null,
        categoryName: null,
        type: "EXPENSE",
        label: "Loyer",
        amount: new Decimal("780.50"),
        frequency: "MONTHLY",
        startDate: new Date("2026-01-05T00:00:00.000Z"),
        endDate: null,
      },
    ]);

    const summary = await readSituationSummary({
      workspace: BUDGET_ONLY,
      params: { scope: "finance", monthKey: "2026-11", horizon: 1 },
      now: NOW,
    });

    expect(summary.finance?.reference.pending).toEqual([
      expect.objectContaining({
        label: "Loyer",
        source: "SERIES",
        status: "PENDING",
        amount: new Decimal("-780.50"),
      }),
    ]);
    expect(summary.finance?.reference.totals).toEqual([
      expect.objectContaining({ currency: "EUR", expenses: new Decimal("780.50") }),
    ]);
    // The read is read-only: no materialisation is attempted by an export.
    expect(budgetReads.listRecurringOccurrences).toHaveBeenCalled();
  });

  it("keeps a decided occurrence out of the pending list but inside the forecast", async () => {
    budgetReads.listAccounts.mockResolvedValue([
      { id: "account-1", name: "Compte courant", type: "CHECKING", currency: "EUR" },
    ]);
    budgetReads.listRecurringEntries.mockResolvedValue([
      {
        id: "entry-1",
        accountId: "account-1",
        accountName: "Compte courant",
        categoryId: null,
        categoryName: null,
        type: "EXPENSE",
        label: "Loyer",
        amount: new Decimal("780.50"),
        frequency: "MONTHLY",
        startDate: new Date("2026-01-05T00:00:00.000Z"),
        endDate: null,
      },
    ]);
    budgetReads.listRecurringOccurrences.mockResolvedValue([
      {
        id: "occurrence-1",
        recurringId: "entry-1",
        date: new Date("2026-11-05T00:00:00.000Z"),
        status: "CONFIRMED",
        transactionId: "tx-1",
        decidedAt: new Date("2026-11-05T10:00:00.000Z"),
      },
    ]);

    const summary = await readSituationSummary({
      workspace: BUDGET_ONLY,
      params: { scope: "finance", monthKey: "2026-11", horizon: 1 },
      now: NOW,
    });

    expect(summary.finance?.reference.pending).toEqual([]);
    expect(summary.finance?.reference.totals).toEqual([
      expect.objectContaining({ confirmedCount: 1, expenses: new Decimal("780.50") }),
    ]);
  });

  it("advances the simulated balance with what is recorded before the window and what is pending", async () => {
    budgetReads.listAccounts.mockResolvedValue([
      { id: "account-1", name: "Compte courant", type: "CHECKING", currency: "EUR" },
    ]);
    budgetReads.listRecurringEntries.mockResolvedValue([
      {
        id: "entry-1",
        accountId: "account-1",
        accountName: "Compte courant",
        categoryId: null,
        categoryName: null,
        type: "EXPENSE",
        label: "Loyer",
        amount: new Decimal("100.00"),
        frequency: "MONTHLY",
        startDate: new Date("2026-01-05T00:00:00.000Z"),
        endDate: null,
      },
    ]);
    budgetReads.sumTransactionsByCurrency.mockResolvedValue(new Map([["EUR", new Decimal("1000.00")]]));

    const summary = await readSituationSummary({
      workspace: BUDGET_ONLY,
      params: { scope: "finance", monthKey: "2026-11", horizon: 1 },
      now: NOW,
    });

    expect(summary.finance?.schedule).toEqual([
      {
        monthKey: "2026-12",
        totals: [expect.objectContaining({ currency: "EUR", expenses: new Decimal("100.00") })],
        balances: [{ currency: "EUR", balance: new Decimal("900.00") }],
      },
    ]);
  });

  it("shows a simulated salary, then the booked amount once the month is recorded", async () => {
    const setting = { hoursPerDay: new Decimal("7.00"), currency: "EUR" };
    const workDays = [
      { date: new Date("2026-11-03T00:00:00.000Z"), status: "WORKED", hours: new Decimal("7.00") },
      { date: new Date("2026-11-04T00:00:00.000Z"), status: "PLANNED", hours: new Decimal("7.00") },
    ];
    budgetReads.listAccounts.mockResolvedValue([
      { id: "account-1", name: "Compte courant", type: "CHECKING", currency: "EUR" },
    ]);
    budgetReads.findSalarySetting.mockResolvedValue(setting);
    budgetReads.listSalaryRates.mockResolvedValue([
      { year: 2026, month: 11, hourlyRate: new Decimal("20.00") },
    ]);
    budgetReads.listWorkDays.mockResolvedValue(workDays);

    const simulated = await readSituationSummary({
      workspace: BUDGET_ONLY,
      params: { scope: "finance", monthKey: "2026-11", horizon: 1 },
      now: NOW,
    });

    expect(simulated.finance?.salary.months[0]).toMatchObject({
      monthKey: "2026-11",
      hourlyRate: new Decimal("20.00"),
      hasCalendar: true,
      plannedHours: new Decimal("7.00"),
      workedHours: new Decimal("7.00"),
      totalHours: new Decimal("14.00"),
      simulatedAmount: new Decimal("280.00"),
      booked: false,
    });
    expect(simulated.finance?.reference.pending).toEqual([
      expect.objectContaining({ label: "Salaire simulé", amount: new Decimal("280.00") }),
    ]);
    // Never stored, never a payslip: the indicative equivalents of the rate in force.
    expect(simulated.finance?.salary.equivalents).toEqual({
      daily: new Decimal("140.00"),
      weekly: new Decimal("700.00"),
      monthly: new Decimal("3033.33"),
    });

    budgetReads.findTransactionByExternalRef.mockImplementation(async (_workspaceId, ref) =>
      ref === "salary:2026-11" ? transaction() : null,
    );

    const booked = await readSituationSummary({
      workspace: BUDGET_ONLY,
      params: { scope: "finance", monthKey: "2026-11", horizon: 1 },
      now: NOW,
    });

    expect(booked.finance?.salary.months[0]).toMatchObject({
      booked: true,
      bookedAmount: new Decimal("280.00"),
    });
    // A booked month is an operation: it must not also appear as a pending prévision.
    expect(booked.finance?.reference.pending).toEqual([]);
    expect(booked.finance?.reference.totals).toEqual([
      expect.objectContaining({ confirmedCount: 1, income: new Decimal("280.00") }),
    ]);
  });

  it("keeps another module's alert out of a budget-only document", async () => {
    listAlertsMock.mockResolvedValue([
      {
        id: "alert-budget",
        kind: "LOW_BALANCE",
        fingerprint: "LOW_BALANCE|account-1",
        status: "ACTIVE",
        inputs: {},
        triggeredAt: new Date("2026-11-15T09:30:00.000Z"),
        lastSeenAt: new Date("2026-11-16T07:00:00.000Z"),
        dismissedAt: null,
        resolvedAt: null,
        createdAt: new Date("2026-11-15T09:30:00.000Z"),
      },
      {
        id: "alert-property",
        kind: "OVERDUE_EVENT",
        fingerprint: "OVERDUE_EVENT|property-1",
        status: "ACTIVE",
        inputs: {},
        triggeredAt: new Date("2026-11-14T09:30:00.000Z"),
        lastSeenAt: new Date("2026-11-16T07:00:00.000Z"),
        dismissedAt: null,
        resolvedAt: null,
        createdAt: new Date("2026-11-14T09:30:00.000Z"),
      },
    ]);

    const financeOnly = await readSituationSummary({
      workspace: ALL_MODULES,
      params: { scope: "finance", monthKey: "2026-11", horizon: 1 },
      now: NOW,
    });
    const everything = await readSituationSummary({
      workspace: ALL_MODULES,
      params: { scope: "all", monthKey: "2026-11", horizon: 1 },
      now: NOW,
    });

    expect(financeOnly.alerts.map((alert) => alert.kind)).toEqual(["LOW_BALANCE"]);
    expect(everything.alerts.map((alert) => alert.kind)).toEqual([
      "LOW_BALANCE",
      "OVERDUE_EVENT",
    ]);
  });

  it("reports a table that hit its bound as a prefix", async () => {
    budgetReads.listRecurringEntries.mockResolvedValue(
      Array.from({ length: 201 }, (_, index) => ({
        id: `entry-${index}`,
        accountId: "account-1",
        accountName: "Compte courant",
        categoryId: null,
        categoryName: null,
        type: "EXPENSE",
        label: `Série ${index}`,
        amount: new Decimal("10.00"),
        frequency: "MONTHLY",
        startDate: new Date("2026-01-05T00:00:00.000Z"),
        endDate: null,
      })),
    );

    const summary = await readSituationSummary({
      workspace: BUDGET_ONLY,
      params: { scope: "finance", monthKey: "2026-11", horizon: 1 },
      now: NOW,
    });

    expect(summary.finance?.series).toHaveLength(200);
    expect(summary.truncated).toContain("series");
  });
});
