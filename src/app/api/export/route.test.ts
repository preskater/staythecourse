import Decimal from "decimal.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requireApiAccessMock = vi.fn();
const listTransactionsMock = vi.fn();
const listPropertiesMock = vi.fn();
const recordAuditEventMock = vi.fn();

vi.mock("@/lib/auth/guard", () => ({
  requireApiAccess: (...args: unknown[]) => requireApiAccessMock(...args),
  moduleUnavailableResponse: () =>
    Response.json({ error: "not_found" }, { status: 404, headers: { "Cache-Control": "no-store" } }),
}));
vi.mock("@/modules/budget/repository", () => ({
  listTransactions: (...args: unknown[]) => listTransactionsMock(...args),
  listBudgets: vi.fn(),
  listBudgetsInRange: vi.fn(),
  listGoals: vi.fn(),
  readAccountBalance: vi.fn(),
  sumGoalContributions: vi.fn(),
}));
vi.mock("@/modules/real-estate/repository", () => ({
  listProperties: (...args: unknown[]) => listPropertiesMock(...args),
}));
vi.mock("@/modules/alerts/repository", () => ({ listAlerts: vi.fn() }));
vi.mock("@/modules/audit/repository", () => ({
  recordAuditEvent: (...args: unknown[]) => recordAuditEventMock(...args),
}));

const { GET } = await import("./route");
const { EXPORT_ENTITIES } = await import("@/lib/exports");

/**
 * Fictitious data only. What these tests pin down: the umbrella route is a selector, not
 * a different export — same session gate, same owner scoping, same builders, same audit
 * entry. An unknown entity is refused before any read, and the response lists what a
 * caller may ask for.
 */
const OWNER = {
  id: "owner-1",
  email: "owner@example.test",
  name: null,
  workspace: { id: "ws-owner-1", role: "OWNER", modules: ["budget", "real-estate"] },
};

const EXPENSE = {
  id: "tx-1",
  type: "EXPENSE",
  amount: new Decimal("-350.00"),
  currency: "EUR",
  operationDate: new Date(Date.UTC(2026, 8, 3)),
  label: "Courses alimentaires",
  accountId: "account-1",
  accountName: "Compte courant",
  categoryId: "category-1",
  categoryName: "Courses",
  notes: null,
  externalRef: null,
  transferGroupId: null,
  reconciledAt: null,
  createdAt: new Date(Date.UTC(2026, 8, 3, 8, 0)),
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(Date.UTC(2026, 9, 6, 12, 0)));
  requireApiAccessMock.mockReset().mockResolvedValue(OWNER);
  listTransactionsMock.mockReset().mockResolvedValue([EXPENSE]);
  listPropertiesMock.mockReset().mockResolvedValue([]);
  recordAuditEventMock.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GET /api/export", () => {
  it("refuses an unauthenticated request and reads nothing", async () => {
    requireApiAccessMock.mockResolvedValue(
      Response.json({ error: "authentication_required" }, { status: 401 }),
    );

    const response = await GET(new Request("http://test.local/api/export?entity=transactions"));

    expect(response.status).toBe(401);
    expect(listTransactionsMock).not.toHaveBeenCalled();
    expect(recordAuditEventMock).not.toHaveBeenCalled();
  });

  it("refuses a missing or unknown entity, listing the supported ones, before any read", async () => {
    for (const url of [
      "http://test.local/api/export",
      "http://test.local/api/export?entity=all",
      "http://test.local/api/export?entity=Transactions",
      "http://test.local/api/export?entity=../../etc/passwd",
    ]) {
      const response = await GET(new Request(url));

      expect(response.status).toBe(400);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(await response.json()).toEqual({
        error: "unknown_entity",
        entities: EXPORT_ENTITIES,
      });
    }

    expect(listTransactionsMock).not.toHaveBeenCalled();
    expect(listPropertiesMock).not.toHaveBeenCalled();
    expect(recordAuditEventMock).not.toHaveBeenCalled();
  });

  it("exports the selected entity through the same builder as its own route", async () => {
    const response = await GET(
      new Request("http://test.local/api/export?entity=transactions&from=2026-09-01&to=2026-09-30"),
    );

    expect(response.status).toBe(200);
    expect(listTransactionsMock).toHaveBeenCalledWith(
      OWNER.workspace.id,
      expect.objectContaining({
        from: new Date(Date.UTC(2026, 8, 1)),
        to: new Date(Date.UTC(2026, 9, 1)),
        take: 10_001,
      }),
    );
    expect(response.headers.get("Content-Disposition")).toBe(
      'attachment; filename="transactions-2026-09-01_2026-09-30.csv"',
    );
    expect(await response.text()).toContain("Courses alimentaires");
  });

  it("keeps each entity's module gate", async () => {
    requireApiAccessMock.mockResolvedValue({
      ...OWNER,
      workspace: { ...OWNER.workspace, modules: ["budget"] },
    });

    const response = await GET(new Request("http://test.local/api/export?entity=properties"));

    expect(response.status).toBe(404);
    expect(listPropertiesMock).not.toHaveBeenCalled();
  });

  it("records the selected entity in the audit trail", async () => {
    await GET(new Request("http://test.local/api/export?entity=transactions&month=2026-09"));

    expect(recordAuditEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: OWNER.workspace.id,
        actorId: OWNER.id,
        action: "export.transactions",
        entityType: "EXPORT",
        outcome: "SUCCESS",
      }),
    );
  });

  it("answers an invalid filter with 400, exactly like the per-entity route", async () => {
    const response = await GET(
      new Request("http://test.local/api/export?entity=transactions&from=2026-13-01"),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "invalid_export_filter",
      parameter: "from",
      code: "invalid_date",
    });
    expect(listTransactionsMock).not.toHaveBeenCalled();
  });
});
