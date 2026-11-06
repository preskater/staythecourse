import Decimal from "decimal.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requireApiAccessMock = vi.fn();
const listTransactionsMock = vi.fn();
const recordAuditEventMock = vi.fn();

vi.mock("@/lib/auth/guard", () => ({
  requireApiAccess: (...args: unknown[]) => requireApiAccessMock(...args),
  moduleUnavailableResponse: () =>
    Response.json({ error: "not_found" }, { status: 404, headers: { "Cache-Control": "no-store" } }),
}));
vi.mock("@/modules/budget/repository", () => ({
  listTransactions: (...args: unknown[]) => listTransactionsMock(...args),
}));
vi.mock("@/modules/audit/repository", () => ({
  recordAuditEvent: (...args: unknown[]) => recordAuditEventMock(...args),
}));

const { GET } = await import("./route");

/**
 * Fictitious data only. What these tests pin down: the historical export keeps its
 * session gate, its owner-scoped read, its month boundaries (start inclusive, end
 * exclusive), its negative outflows untouched (a minus sign is not a formula), its
 * filters, its row bound, and the audit entry every delivered file leaves behind.
 */
const OWNER = {
  id: "owner-1",
  email: "owner@example.test",
  name: null,
  workspace: { id: "ws-owner-1", role: "OWNER", modules: ["budget"] },
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

async function bodyOf(response: Response): Promise<string[]> {
  return (await response.text()).replace(/^\uFEFF/, "").split("\r\n");
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(Date.UTC(2026, 9, 6, 12, 0)));
  requireApiAccessMock.mockReset().mockResolvedValue(OWNER);
  listTransactionsMock.mockReset().mockResolvedValue([EXPENSE]);
  recordAuditEventMock.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GET /api/export/transactions", () => {
  it("refuses an unauthenticated request and reads nothing", async () => {
    requireApiAccessMock.mockResolvedValue(
      Response.json({ error: "authentication_required" }, { status: 401 }),
    );

    const response = await GET(new Request("http://test.local/api/export/transactions"));

    expect(response.status).toBe(401);
    expect(listTransactionsMock).not.toHaveBeenCalled();
  });

  it("answers 404 and reads nothing when the budget module is disabled", async () => {
    requireApiAccessMock.mockResolvedValue(Response.json({ error: "not_found" }, { status: 404 }));

    const response = await GET(new Request("http://test.local/api/export/transactions"));

    expect(response.status).toBe(404);
    expect(listTransactionsMock).not.toHaveBeenCalled();
  });

  it("reads the requested month for the signed-in owner, end date exclusive", async () => {
    const response = await GET(
      new Request("http://test.local/api/export/transactions?month=2026-09"),
    );

    expect(response.status).toBe(200);
    expect(requireApiAccessMock).toHaveBeenCalledWith("export", "budget");
    expect(listTransactionsMock).toHaveBeenCalledTimes(1);

    const [workspaceId, options] = listTransactionsMock.mock.calls[0] as [
      string,
      { from: Date; to: Date; take: number },
    ];
    expect(workspaceId).toBe(OWNER.workspace.id);
    expect(options.from.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    // Exclusive upper bound: the 1st of the next month is not part of September.
    expect(options.to.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    // One row above the cap: its presence is what proves the window was cut.
    expect(options.take).toBe(10_001);

    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Disposition")).toBe(
      'attachment; filename="transactions-2026-09.csv"',
    );
  });

  it("falls back to the current month when the filter is absent or malformed", async () => {
    await GET(new Request("http://test.local/api/export/transactions"));
    let options = listTransactionsMock.mock.calls.at(-1)?.[1] as { from: Date };
    expect(options.from.toISOString()).toBe("2026-10-01T00:00:00.000Z");

    await GET(new Request("http://test.local/api/export/transactions?month=2026-9"));
    options = listTransactionsMock.mock.calls.at(-1)?.[1] as { from: Date };
    expect(options.from.toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });

  it("keeps a negative outflow as a number, dates as calendar days, and currencies explicit", async () => {
    const lines = await bodyOf(
      await GET(new Request("http://test.local/api/export/transactions?month=2026-09")),
    );

    expect(lines[0]).toBe(
      "date_operation,libelle,compte,categorie,type,montant,devise,pointe_le,notes,reference_source",
    );
    expect(lines[1]).toBe(
      "2026-09-03,Courses alimentaires,Compte courant,Courses,EXPENSE,-350.00,EUR,,,",
    );
  });

  it("writes the reconciliation day when the line was checked", async () => {
    listTransactionsMock.mockResolvedValue([
      { ...EXPENSE, reconciledAt: new Date(Date.UTC(2026, 9, 7)) },
    ]);

    const lines = await bodyOf(
      await GET(new Request("http://test.local/api/export/transactions?month=2026-09")),
    );

    expect(lines[1]).toContain(",2026-10-07,");
  });

  it("exports a whole year when asked, with an exclusive end and its own file name", async () => {
    const response = await GET(
      new Request("http://test.local/api/export/transactions?year=2026"),
    );

    const options = listTransactionsMock.mock.calls.at(-1)?.[1] as { from: Date; to: Date };
    expect(options.from.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(options.to.toISOString()).toBe("2027-01-01T00:00:00.000Z");
    expect(response.headers.get("Content-Disposition")).toBe(
      'attachment; filename="transactions-2026.csv"',
    );
  });

  it("exports every month when all=1, and falls back to the month otherwise", async () => {
    const response = await GET(
      new Request("http://test.local/api/export/transactions?all=1"),
    );

    const options = listTransactionsMock.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect(options.from).toBeUndefined();
    expect(options.to).toBeUndefined();
    expect(response.headers.get("Content-Disposition")).toBe(
      'attachment; filename="transactions-complet.csv"',
    );

    // A malformed year falls back to the current month rather than 500 or an empty file.
    await GET(new Request("http://test.local/api/export/transactions?year=26"));
    const fallback = listTransactionsMock.mock.calls.at(-1)?.[1] as { from: Date };
    expect(fallback.from.toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });

  it("forwards the reconciliation filter", async () => {
    await GET(
      new Request("http://test.local/api/export/transactions?month=2026-09&reconciled=0"),
    );

    const options = listTransactionsMock.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect(options.reconciled).toBe(false);

    await GET(
      new Request("http://test.local/api/export/transactions?month=2026-09&reconciled=1"),
    );
    const checked = listTransactionsMock.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect(checked.reconciled).toBe(true);
  });

  it("forwards the account, category, type and search filters", async () => {
    await GET(
      new Request(
        "http://test.local/api/export/transactions?month=2026-09&account=a1&category=c1&type=EXPENSE&q=loyer",
      ),
    );

    const options = listTransactionsMock.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect(options.accountId).toBe("a1");
    expect(options.categoryId).toBe("c1");
    expect(options.type).toBe("EXPENSE");
    expect(options.search).toBe("loyer");
  });

  it("ignores an unknown type instead of returning an empty file by accident", async () => {
    await GET(new Request("http://test.local/api/export/transactions?type=NOT_A_TYPE"));

    const options = listTransactionsMock.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect(options.type).toBeUndefined();
  });


  it("applies an explicit from/to window, both calendar days inclusive", async () => {
    const response = await GET(
      new Request(
        "http://test.local/api/export/transactions?from=2026-09-03&to=2026-09-30",
      ),
    );

    const options = listTransactionsMock.mock.calls.at(-1)?.[1] as { from: Date; to: Date };
    expect(options.from.toISOString()).toBe("2026-09-03T00:00:00.000Z");
    // `to` is inclusive as written: the read stops at the next day, exclusive.
    expect(options.to.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(response.headers.get("Content-Disposition")).toBe(
      'attachment; filename="transactions-2026-09-03_2026-09-30.csv"',
    );
  });

  it("takes an open-ended window, and says which side is open in the file name", async () => {
    const response = await GET(
      new Request("http://test.local/api/export/transactions?from=2026-09-03"),
    );

    const options = listTransactionsMock.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect((options.from as Date).toISOString()).toBe("2026-09-03T00:00:00.000Z");
    expect(options.to).toBeUndefined();
    expect(response.headers.get("Content-Disposition")).toBe(
      'attachment; filename="transactions-depuis-2026-09-03.csv"',
    );
  });

  it("lets an explicit window win over the month, year and all scopes", async () => {
    await GET(
      new Request(
        "http://test.local/api/export/transactions?all=1&year=2025&month=2026-08&from=2026-09-03&to=2026-09-30",
      ),
    );

    const options = listTransactionsMock.mock.calls.at(-1)?.[1] as { from: Date };
    expect(options.from.toISOString()).toBe("2026-09-03T00:00:00.000Z");
  });

  it("keeps only an upper bound, and ignores an empty parameter", async () => {
    const upper = await GET(
      new Request("http://test.local/api/export/transactions?to=2026-09-30"),
    );

    const options = listTransactionsMock.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect(options.from).toBeUndefined();
    expect((options.to as Date).toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(upper.headers.get("Content-Disposition")).toBe(
      'attachment; filename="transactions-jusqua-2026-09-30.csv"',
    );

    // `?from=` is what an empty form field produces: it means "no bound", not "today".
    await GET(new Request("http://test.local/api/export/transactions?from=&month=2026-08"));
    const blank = listTransactionsMock.mock.calls.at(-1)?.[1] as { from: Date };
    expect(blank.from.toISOString()).toBe("2026-08-01T00:00:00.000Z");
  });

  it("refuses a malformed date and a reversed range without reading any row", async () => {
    const malformed = await GET(
      new Request("http://test.local/api/export/transactions?from=2026-9-3"),
    );
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({
      error: "invalid_export_filter",
      parameter: "from",
      code: "invalid_date",
    });

    const impossible = await GET(
      new Request("http://test.local/api/export/transactions?from=2026-02-31"),
    );
    expect(impossible.status).toBe(400);

    const badUpper = await GET(
      new Request("http://test.local/api/export/transactions?to=demain"),
    );
    expect(badUpper.status).toBe(400);
    expect(await badUpper.json()).toMatchObject({ parameter: "to", code: "invalid_date" });

    const reversed = await GET(
      new Request("http://test.local/api/export/transactions?from=2026-09-30&to=2026-09-01"),
    );
    expect(reversed.status).toBe(400);
    expect(await reversed.json()).toMatchObject({ code: "reversed_range" });

    expect(listTransactionsMock).not.toHaveBeenCalled();
  });

  it("states that the file was cut when the read reached the row cap", async () => {
    listTransactionsMock.mockResolvedValue(
      Array.from({ length: 10_001 }, (_, index) => ({ ...EXPENSE, id: `tx-${index}` })),
    );

    const response = await GET(
      new Request("http://test.local/api/export/transactions?month=2026-09"),
    );

    expect(response.headers.get("X-Export-Truncated")).toBe("true");
    const lines = await bodyOf(response);
    // The extra row is never written: exactly the cap, plus the header line.
    expect(lines).toHaveLength(10_001);
  });

  it("says the file is complete when the read stayed below the cap", async () => {
    const response = await GET(
      new Request("http://test.local/api/export/transactions?month=2026-09"),
    );

    expect(response.headers.get("X-Export-Truncated")).toBe("false");
  });

  it("records one owner-scoped audit entry, with counts and codes only", async () => {
    await GET(
      new Request(
        "http://test.local/api/export/transactions?from=2026-09-03&to=2026-09-30",
      ),
    );

    expect(recordAuditEventMock).toHaveBeenCalledWith({
      workspaceId: OWNER.workspace.id,
      actorId: OWNER.id,
      action: "export.transactions",
      entityType: "EXPORT",
      outcome: "SUCCESS",
      metadata: {
        entity: "transactions",
        scope: "range",
        from: "2026-09-03",
        to: "2026-09-30",
        rows: 1,
        truncated: false,
      },
    });
  });

  it("withholds the file when the audit entry cannot be written", async () => {
    recordAuditEventMock.mockRejectedValue(new Error("audit unavailable"));

    const response = await GET(
      new Request("http://test.local/api/export/transactions?month=2026-09"),
    );

    expect(response.status).toBe(500);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "audit_unavailable" });
  });

  it("writes a header line even for a month without any operation", async () => {
    listTransactionsMock.mockResolvedValue([]);

    const lines = await bodyOf(
      await GET(new Request("http://test.local/api/export/transactions?month=2026-08")),
    );

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("date_operation");
  });

  it("neutralises a formula typed in a label", async () => {
    listTransactionsMock.mockResolvedValue([
      { ...EXPENSE, label: "=1+1", notes: "@SUM(A1:A9)" },
    ]);

    const lines = await bodyOf(
      await GET(new Request("http://test.local/api/export/transactions?month=2026-09")),
    );

    expect(lines[1]).toContain("'=1+1");
    expect(lines[1]).toContain("'@SUM(A1:A9)");
  });
});
