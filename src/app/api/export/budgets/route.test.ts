import Decimal from "decimal.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requireApiAccessMock = vi.fn();
const listBudgetsMock = vi.fn();
const listBudgetsInRangeMock = vi.fn();
const recordAuditEventMock = vi.fn();

vi.mock("@/lib/auth/guard", () => ({
  // The real gate is covered by `src/lib/auth/guard.test.ts` and the route × role
  // matrix; these tests pin the route's read and CSV behaviour.
  requireApiAccess: (...args: unknown[]) => requireApiAccessMock(...args),
  moduleUnavailableResponse: () =>
    Response.json({ error: "not_found" }, { status: 404, headers: { "Cache-Control": "no-store" } }),
}));
vi.mock("@/modules/budget/repository", () => ({
  listBudgets: (...args: unknown[]) => listBudgetsMock(...args),
  listBudgetsInRange: (...args: unknown[]) => listBudgetsInRangeMock(...args),
}));
vi.mock("@/modules/audit/repository", () => ({
  recordAuditEvent: (...args: unknown[]) => recordAuditEventMock(...args),
}));

const { GET } = await import("./route");

/**
 * Fictitious data only. What these tests pin down: the file stays behind the session,
 * the read is owner-scoped, the month filter has a defined fallback, an empty month
 * still produces a header line, and the CSV guards keep applying to the new columns.
 */
const OWNER = {
  id: "owner-1",
  email: "owner@example.test",
  name: null,
  workspace: { id: "ws-owner-1", role: "OWNER", modules: ["budget"] },
};

const BUDGET_EUR = {
  id: "budget-1",
  categoryId: "category-1",
  categoryName: "Courses",
  categoryKind: "EXPENSE",
  year: 2026,
  month: 9,
  currency: "EUR",
  amount: new Decimal("400"),
};

const BUDGET_USD = {
  ...BUDGET_EUR,
  id: "budget-2",
  categoryId: "category-2",
  categoryName: "Abonnements",
  currency: "USD",
  amount: new Decimal("35.50"),
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(Date.UTC(2026, 9, 6, 12, 0)));
  requireApiAccessMock.mockReset().mockResolvedValue(OWNER);
  listBudgetsMock.mockReset().mockResolvedValue([BUDGET_EUR, BUDGET_USD]);
  listBudgetsInRangeMock.mockReset().mockResolvedValue([BUDGET_EUR, BUDGET_USD]);
  recordAuditEventMock.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GET /api/export/budgets", () => {
  it("refuses an unauthenticated request and reads nothing", async () => {
    requireApiAccessMock.mockResolvedValue(
      Response.json({ error: "authentication_required" }, { status: 401 }),
    );

    const response = await GET(new Request("http://test.local/api/export/budgets"));

    expect(response.status).toBe(401);
    expect(listBudgetsMock).not.toHaveBeenCalled();
  });

  it("answers 404 and reads nothing when the budget module is disabled", async () => {
    requireApiAccessMock.mockResolvedValue(Response.json({ error: "not_found" }, { status: 404 }));

    const response = await GET(new Request("http://test.local/api/export/budgets"));

    expect(response.status).toBe(404);
    expect(listBudgetsMock).not.toHaveBeenCalled();
  });

  it("exports the requested month, owner-scoped, with currencies kept apart", async () => {
    const response = await GET(
      new Request("http://test.local/api/export/budgets?month=2026-09"),
    );

    expect(response.status).toBe(200);
    expect(requireApiAccessMock).toHaveBeenCalledWith("export", "budget");
    expect(listBudgetsMock).toHaveBeenCalledWith(OWNER.workspace.id, { year: 2026, month: 9 });

    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Disposition")).toBe(
      'attachment; filename="budgets-2026-09.csv"',
    );

    const lines = (await response.text()).replace(/^\uFEFF/, "").split("\r\n");
    expect(lines[0]).toBe("mois,categorie,nature,devise,montant_prevu");
    expect(lines[1]).toBe("2026-09,Courses,EXPENSE,EUR,400.00");
    // The USD budget keeps its own currency and amount: no conversion, ever.
    expect(lines[2]).toBe("2026-09,Abonnements,EXPENSE,USD,35.50");
  });

  it("falls back to the current month when the filter is absent or malformed", async () => {
    await GET(new Request("http://test.local/api/export/budgets"));
    expect(listBudgetsMock).toHaveBeenLastCalledWith(OWNER.workspace.id, { year: 2026, month: 10 });

    await GET(new Request("http://test.local/api/export/budgets?month=2026-13"));
    expect(listBudgetsMock).toHaveBeenLastCalledWith(OWNER.workspace.id, { year: 2026, month: 10 });
  });


  it("exports a window of whole months, each row carrying its own month", async () => {
    listBudgetsInRangeMock.mockResolvedValue([
      BUDGET_EUR,
      { ...BUDGET_EUR, id: "budget-2", year: 2026, month: 3, amount: new Decimal("420") },
    ]);

    const response = await GET(
      new Request("http://test.local/api/export/budgets?from=2026-01-15&to=2026-03-02"),
    );

    // A budget is stored per month: the window snaps to January-March 2026.
    expect(listBudgetsInRangeMock).toHaveBeenCalledWith(OWNER.workspace.id, {
      from: { year: 2026, month: 1 },
      to: { year: 2026, month: 3 },
      take: 10_001,
    });
    expect(listBudgetsMock).not.toHaveBeenCalled();

    expect(response.headers.get("Content-Disposition")).toBe(
      'attachment; filename="budgets-2026-01_2026-03.csv"',
    );

    const lines = (await response.text()).replace(/^\uFEFF/, "").split("\r\n");
    expect(lines[1]).toBe("2026-09,Courses,EXPENSE,EUR,400.00");
    expect(lines[2]).toBe("2026-03,Courses,EXPENSE,EUR,420.00");
  });

  it("ends on the month of the last included day, even at a month boundary", async () => {
    await GET(new Request("http://test.local/api/export/budgets?to=2026-03-31"));

    // The exclusive end is 2026-04-01; stepping back a day keeps March, not April.
    expect(listBudgetsInRangeMock).toHaveBeenLastCalledWith(OWNER.workspace.id, {
      from: undefined,
      to: { year: 2026, month: 3 },
      take: 10_001,
    });
  });

  it("keeps one side of a month window open", async () => {
    await GET(new Request("http://test.local/api/export/budgets?from=2026-01-01"));

    expect(listBudgetsInRangeMock).toHaveBeenLastCalledWith(OWNER.workspace.id, {
      from: { year: 2026, month: 1 },
      to: undefined,
      take: 10_001,
    });
  });

  it("refuses a reversed window instead of exporting the wrong months", async () => {
    const response = await GET(
      new Request("http://test.local/api/export/budgets?from=2026-06-01&to=2026-01-31"),
    );

    expect(response.status).toBe(400);
    expect(listBudgetsMock).not.toHaveBeenCalled();
    expect(listBudgetsInRangeMock).not.toHaveBeenCalled();
  });

  it("records the export in the audit trail with its scope and row count", async () => {
    await GET(new Request("http://test.local/api/export/budgets?month=2026-09"));

    expect(recordAuditEventMock).toHaveBeenCalledWith({
      workspaceId: OWNER.workspace.id,
      actorId: OWNER.id,
      action: "export.budgets",
      entityType: "EXPORT",
      outcome: "SUCCESS",
      metadata: {
        entity: "budgets",
        scope: "month",
        from: "2026-09",
        to: undefined,
        rows: 2,
        truncated: false,
      },
    });
  });

  it("writes a header line even when the month has no budget", async () => {
    listBudgetsMock.mockResolvedValue([]);

    const response = await GET(
      new Request("http://test.local/api/export/budgets?month=2026-08"),
    );

    const body = (await response.text()).replace(/^\uFEFF/, "");
    expect(body).toBe("mois,categorie,nature,devise,montant_prevu");
  });

  it("neutralises a formula typed in a category name", async () => {
    listBudgetsMock.mockResolvedValue([
      { ...BUDGET_EUR, categoryName: "=SUM(A1:A9)" },
    ]);

    const response = await GET(
      new Request("http://test.local/api/export/budgets?month=2026-09"),
    );

    const body = await response.text();
    expect(body).toContain("'=SUM(A1:A9)");
    expect(body).not.toContain(",=SUM(A1:A9)");
  });
});
