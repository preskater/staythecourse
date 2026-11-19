import Decimal from "decimal.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * OpenAI cost import (M11-02), end to end from a fake `fetch` to a fake table.
 *
 * The fake table honours the unique key `(workspaceId, connectionKey, externalId)` the
 * way PostgreSQL would, so "a re-run creates nothing new" is checked on the rows, not
 * assumed. No test reaches OpenAI or a database, and the key is fictitious.
 */

type Row = { workspaceId: string; connectionKey: string; externalId: string; amount: Decimal; currency: string; periodStart: Date };
const rows = new Map<string, Row>();

const prisma = {
  aiCostLine: {
    upsert: vi.fn(async (args: { where: { workspaceId_connectionKey_externalId: Record<string, string> }; create: Row; update: Partial<Row> }) => {
      const { workspaceId, connectionKey, externalId } = args.where.workspaceId_connectionKey_externalId;
      const key = `${workspaceId}|${connectionKey}|${externalId}`;
      const existing = rows.get(key);
      rows.set(key, existing ? { ...existing, ...args.update } : args.create);
    }),
    groupBy: vi.fn(async (args: { where: { workspaceId: string; connectionKey: string; periodStart: { gte: Date; lt: Date } } }) => {
      const sums = new Map<string, Decimal>();
      for (const row of rows.values()) {
        const { where } = args;
        if (
          row.workspaceId !== where.workspaceId ||
          row.connectionKey !== where.connectionKey ||
          row.periodStart < where.periodStart.gte ||
          row.periodStart >= where.periodStart.lt
        ) continue;
        sums.set(row.currency, (sums.get(row.currency) ?? new Decimal(0)).plus(row.amount));
      }
      return [...sums].map(([currency, amount]) => ({ currency, _sum: { amount } }));
    }),
  },
  $transaction: vi.fn(async (work: Promise<unknown>[]) => Promise.all(work)),
};

vi.mock("@/lib/db", () => ({ getPrisma: () => prisma }));

const auditMock = vi.fn(async (entry: unknown) => {
  void entry;
});
vi.mock("@/modules/audit/repository", () => ({ recordAuditEventSafely: auditMock }));

const { importOpenAiCosts } = await import("./openai-import");

const TOKEN = "fake-openai-admin-key";
const DAY = 86_400;
const START = Date.UTC(2026, 9, 1) / 1000;
const PAGES = 3;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const pageIndex = (url: URL) => {
  const page = url.searchParams.get("page");
  return page ? Number(page.split("_")[1]) - 1 : 0;
};

/** Grouped: 0.04 + 0.01 per day. Ungrouped total: 0.05 per day. */
function costs(url: URL): Response {
  const index = pageIndex(url);
  const start = START + index * DAY;
  const grouped = url.searchParams.getAll("group_by").length > 0;
  const results = grouped
    ? [
        { amount: { value: 0.04, currency: "usd" }, project_id: "proj_1", line_item: "gpt-x, input" },
        { amount: { value: 0.01, currency: "usd" }, project_id: null, line_item: "gpt-x, output" },
      ]
    : [{ amount: { value: 0.05, currency: "usd" } }];

  return json({
    object: "page",
    data: [{ object: "bucket", start_time: start, end_time: start + DAY, results }],
    has_more: index < PAGES - 1,
    next_page: index < PAGES - 1 ? `page_${index + 2}` : null,
  });
}

const fetchFrom = (handler: (url: URL) => Response) =>
  (async (input: RequestInfo | URL) => handler(new URL(String(input)))) as typeof fetch;

const run = (fetchImpl: typeof fetch, cursor: string | null = null) =>
  importOpenAiCosts({
    workspaceId: "ws-1",
    actorId: "user-1",
    connectionKey: "openai-main",
    request: {
      token: TOKEN,
      instanceUrl: "",
      fetchImpl,
      start: new Date(START * 1000),
      end: new Date((START + PAGES * DAY) * 1000),
      cursor,
    },
  });

beforeEach(() => {
  rows.clear();
  auditMock.mockClear();
});

describe("importOpenAiCosts", () => {
  it("imports every line and reconciles with the organization total", async () => {
    const result = await run(fetchFrom(costs));

    expect(result).toMatchObject({ linesImported: 6, stoppedBy: null, nextCursor: null });
    expect(result.reconciliation).toEqual({
      status: "RECONCILED",
      currencies: [
        { currency: "USD", imported: "0.15", provider: "0.15", difference: "0", withinTolerance: true },
      ],
    });
    expect(rows.size).toBe(6);
  });

  it("creates nothing new when the same window is imported again", async () => {
    await run(fetchFrom(costs));
    await run(fetchFrom(costs));

    expect(rows.size).toBe(6);
  });

  it("stores the pages read before a rate limit, does not reconcile, and resumes", async () => {
    const partial = await run(
      fetchFrom((url) => (pageIndex(url) > 0 ? json({}, 429, { "retry-after": "30" }) : costs(url))),
    );

    expect(partial).toMatchObject({ linesImported: 2, stoppedBy: "RATE_LIMITED", nextCursor: "page_2" });
    expect(partial.reconciliation.status).toBe("INCOMPLETE");
    expect(rows.size).toBe(2);

    // The resumed run reads the rest, and reconciles the whole window from the stored lines.
    const resumed = await run(fetchFrom(costs), partial.nextCursor);
    expect(rows.size).toBe(6);
    expect(resumed.reconciliation.status).toBe("RECONCILED");
  });

  it("reports a mismatch when stored lines and the provider total disagree", async () => {
    const result = await importOpenAiCosts(
      {
        workspaceId: "ws-1",
        actorId: null,
        connectionKey: "openai-main",
        request: {
          token: TOKEN,
          instanceUrl: "",
          fetchImpl: fetchFrom(costs),
          start: new Date(START * 1000),
          end: new Date((START + PAGES * DAY) * 1000),
          cursor: null,
        },
      },
      {
        organizationTotals: async () => ({ totals: new Map([["USD", new Decimal("0.20")]]), complete: true }),
      },
    );

    expect(result.reconciliation.status).toBe("MISMATCH");
    expect(result.reconciliation.currencies[0].difference).toBe("-0.05");
  });

  it("stores nothing and audits a failure on a revoked key", async () => {
    await expect(run(fetchFrom(() => json({ error: "invalid key" }, 401)))).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });

    expect(rows.size).toBe(0);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "FAILED", metadata: expect.objectContaining({ error: "UNAUTHORIZED" }) }),
    );
  });

  it("audits counts and codes only, never the key or an amount", async () => {
    await run(fetchFrom(costs));

    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-1",
        action: "integration.sync",
        outcome: "SUCCESS",
        metadata: expect.objectContaining({ lines: 6, reconciliation: "RECONCILED" }),
      }),
    );
    const serialized = JSON.stringify(auditMock.mock.calls);
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain("0.15");
  });
});
