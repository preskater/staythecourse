import Decimal from "decimal.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EXPORT_TRUNCATED_HEADER } from "@/lib/csv";

const requireApiAccessMock = vi.fn();
const readSituationSummaryMock = vi.fn();
const recordAuditEventMock = vi.fn();

vi.mock("@/lib/auth/guard", () => ({
  requireApiAccess: (...args: unknown[]) => requireApiAccessMock(...args),
  moduleUnavailableResponse: () =>
    Response.json({ error: "not_found" }, { status: 404, headers: { "Cache-Control": "no-store" } }),
}));

// The parameters and their refusal stay real; only the reads are stubbed, so this file
// pins the route's guards, defaults, audit entry and response headers.
vi.mock("@/modules/dashboard/summary", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/dashboard/summary")>();

  return {
    ...actual,
    readSituationSummary: (...args: unknown[]) => readSituationSummaryMock(...args),
  };
});

vi.mock("@/modules/audit/repository", () => ({
  recordAuditEvent: (...args: unknown[]) => recordAuditEventMock(...args),
}));

const { GET } = await import("./route");

const OWNER = {
  id: "owner-1",
  email: "owner@example.test",
  name: null,
  workspace: {
    id: "ws-owner-1",
    name: "Espace fictif",
    kind: "PERSONAL",
    role: "OWNER",
    modules: ["budget"],
  },
};

/** The smallest complete document: the header, the sections table and the alerts. */
const SUMMARY = {
  generatedAt: new Date("2026-11-16T08:00:00.000Z"),
  scope: "all" as const,
  monthKey: "2026-11",
  monthLabel: "novembre 2026",
  horizon: 6,
  horizonKeys: ["2026-12"],
  workspace: { name: "Espace fictif", kind: "PERSONAL" as const },
  defaultCurrency: "EUR",
  timeZone: "Europe/Paris",
  modules: ["budget"] as const,
  sections: [],
  truncated: [],
  finance: {
    accounts: [],
    accountTotals: [],
    series: [],
    reference: {
      monthKey: "2026-11",
      actuals: [],
      budgets: { lines: [], totals: [] },
      pending: [],
      totals: [],
    },
    salary: { hoursPerDay: null, currency: null, equivalents: null, months: [] },
    schedule: [],
    savings: [],
    goals: [],
  },
  realEstate: null,
  microBusiness: null,
  integrations: null,
  alerts: [],
};

beforeEach(() => {
  requireApiAccessMock.mockReset().mockResolvedValue(OWNER);
  readSituationSummaryMock.mockReset().mockResolvedValue(SUMMARY);
  recordAuditEventMock.mockReset().mockResolvedValue(undefined);
});

describe("GET /api/export/summary", () => {
  it("refuses an unauthenticated request and reads nothing", async () => {
    requireApiAccessMock.mockResolvedValue(
      Response.json({ error: "authentication_required" }, { status: 401 }),
    );

    const response = await GET(new Request("http://test.local/api/export/summary"));

    expect(response.status).toBe(401);
    expect(readSituationSummaryMock).not.toHaveBeenCalled();
    expect(recordAuditEventMock).not.toHaveBeenCalled();
  });

  it("refuses a role without the export permission and writes no trail entry", async () => {
    requireApiAccessMock.mockResolvedValue(
      Response.json({ error: "forbidden" }, { status: 403 }),
    );

    const response = await GET(new Request("http://test.local/api/export/summary"));

    expect(response.status).toBe(403);
    expect(readSituationSummaryMock).not.toHaveBeenCalled();
    expect(recordAuditEventMock).not.toHaveBeenCalled();
  });

  it("requires the export permission, not a module, before anything is read", async () => {
    await GET(new Request("http://test.local/api/export/summary"));

    expect(requireApiAccessMock).toHaveBeenCalledWith("export");
  });

  it("refuses an unknown scope with 400 before reading", async () => {
    const response = await GET(
      new Request("http://test.local/api/export/summary?scope=tout"),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "invalid_export_filter",
      parameter: "scope",
      code: "invalid_scope",
    });
    expect(readSituationSummaryMock).not.toHaveBeenCalled();
    expect(recordAuditEventMock).not.toHaveBeenCalled();
  });

  it("refuses an out-of-range horizon with 400 before reading", async () => {
    const response = await GET(new Request("http://test.local/api/export/summary?horizon=99"));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ parameter: "horizon", code: "invalid_horizon" });
    expect(readSituationSummaryMock).not.toHaveBeenCalled();
  });

  it("downloads the document, with no-store and the audit entry", async () => {
    const response = await GET(
      new Request("http://test.local/api/export/summary?scope=finance&horizon=3"),
    );

    expect(readSituationSummaryMock).toHaveBeenCalledWith({
      workspace: OWNER.workspace,
      params: expect.objectContaining({ scope: "finance", horizon: 3 }),
    });
    expect(response.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
    expect(response.headers.get("Content-Disposition")).toBe(
      'attachment; filename="synthese-2026-11.md"',
    );
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get(EXPORT_TRUNCATED_HEADER)).toBe("false");
    expect(await response.text()).toContain("# Synthèse de situation — novembre 2026");

    expect(recordAuditEventMock).toHaveBeenCalledWith({
      workspaceId: OWNER.workspace.id,
      actorId: OWNER.id,
      action: "export.summary",
      entityType: "EXPORT",
      outcome: "SUCCESS",
      metadata: {
        entity: "summary",
        scope: "all",
        month: "2026-11",
        horizon: 6,
        sections: 0,
        truncated: false,
      },
    });
  });

  it("marks the response when a section was cut", async () => {
    readSituationSummaryMock.mockResolvedValue({
      ...SUMMARY,
      truncated: ["series"],
      finance: {
        ...SUMMARY.finance,
        accountTotals: [],
        accounts: [],
        series: [
          {
            label: "Loyer",
            type: "EXPENSE",
            amount: new Decimal("10.00"),
            currency: "EUR",
            frequency: "MONTHLY",
            accountName: "Compte courant",
            categoryName: null,
            startDate: new Date("2026-01-05T00:00:00.000Z"),
            endDate: null,
          },
        ],
      },
    });

    const response = await GET(new Request("http://test.local/api/export/summary"));

    expect(response.headers.get(EXPORT_TRUNCATED_HEADER)).toBe("true");
    expect(recordAuditEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ truncated: true }) }),
    );
  });

  it("withholds the file when the trail cannot be written", async () => {
    recordAuditEventMock.mockRejectedValue(new Error("database unavailable"));

    const response = await GET(new Request("http://test.local/api/export/summary"));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "audit_unavailable" });
  });
});
