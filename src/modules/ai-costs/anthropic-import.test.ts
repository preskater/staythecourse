import Decimal from "decimal.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Anthropic usage and cost import (M11-03), end to end from a fake `fetch` to fake
 * tables. The fake tables honour the unique key `(workspaceId, connectionKey,
 * externalId)` the way PostgreSQL would, so "a re-run creates nothing new" is checked on
 * the rows. No test reaches Anthropic or a database, and the key is fictitious.
 */

type Row = Record<string, unknown> & { workspaceId: string; connectionKey: string; externalId: string };

function fakeTable() {
  const rows = new Map<string, Row>();
  return {
    rows,
    upsert: vi.fn(async (args: { where: { workspaceId_connectionKey_externalId: Record<string, string> }; create: Row; update: Partial<Row> }) => {
      const { workspaceId, connectionKey, externalId } = args.where.workspaceId_connectionKey_externalId;
      const key = `${workspaceId}|${connectionKey}|${externalId}`;
      const existing = rows.get(key);
      rows.set(key, existing ? { ...existing, ...args.update } : args.create);
    }),
  };
}

const costs = fakeTable();
const usage = fakeTable();

const prisma = {
  aiCostLine: {
    upsert: costs.upsert,
    groupBy: vi.fn(async (args: { where: { workspaceId: string; connectionKey: string; periodStart: { gte: Date; lt: Date } } }) => {
      const sums = new Map<string, Decimal>();
      for (const row of costs.rows.values()) {
        const { where } = args;
        const start = row.periodStart as Date;
        if (
          row.workspaceId !== where.workspaceId ||
          row.connectionKey !== where.connectionKey ||
          start < where.periodStart.gte ||
          start >= where.periodStart.lt
        ) continue;
        const currency = row.currency as string;
        sums.set(currency, (sums.get(currency) ?? new Decimal(0)).plus(row.amount as Decimal));
      }
      return [...sums].map(([currency, amount]) => ({ currency, _sum: { amount } }));
    }),
  },
  aiUsageLine: { upsert: usage.upsert },
  $transaction: vi.fn(async (work: Promise<unknown>[]) => Promise.all(work)),
};

vi.mock("@/lib/db", () => ({ getPrisma: () => prisma }));

const auditMock = vi.fn(async (entry: unknown) => {
  void entry;
});
vi.mock("@/modules/audit/repository", () => ({ recordAuditEventSafely: auditMock }));

const { importAnthropicUsageAndCosts } = await import("./anthropic-import");

const TOKEN = "fake-anthropic-admin-key";
const DAY = 86_400_000;
const START = Date.UTC(2026, 9, 1);
const PAGES = 3;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const pageIndex = (url: URL) => {
  const page = url.searchParams.get("page");
  return page ? Number(page.split("_")[1]) - 1 : 0;
};

const day = (index: number) => ({
  starting_at: new Date(START + index * DAY).toISOString(),
  ending_at: new Date(START + (index + 1) * DAY).toISOString(),
});

const tokens = {
  uncached_input_tokens: 100,
  cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
  cache_read_input_tokens: 0,
  output_tokens: 10,
  requests: 2,
};

/** One page per day. Grouped cost: 4 + 1 cents. Ungrouped total: 5 cents. */
function anthropic(url: URL): Response {
  const index = pageIndex(url);
  const grouped = url.searchParams.getAll("group_by[]").length > 0;
  const data =
    url.pathname === "/v1/organizations/analytics/usage"
      ? [
          { ...day(index), group: { model: "claude-x", workspace_id: "wrkspc_1", service_tier: "priority" }, usage: tokens },
          { ...day(index), group: { model: null, workspace_id: "wrkspc_1" }, usage: tokens },
        ]
      : grouped
        ? [
            { ...day(index), group: { model: "claude-x", cost_type: "tokens", token_type: "output_tokens" }, cost: { currency: "USD", amount: "4.000000" } },
            { ...day(index), group: { model: null, cost_type: "code_execution" }, cost: { currency: "USD", amount: "1.000000" } },
          ]
        : [{ ...day(index), group: {}, cost: { currency: "USD", amount: "5.000000" } }];

  return json({
    data,
    has_more: index < PAGES - 1,
    next_page: index < PAGES - 1 ? `page_${index + 2}` : null,
    data_refreshed_at: "2026-11-15T00:00:00Z",
  });
}

const fetchFrom = (handler: (url: URL) => Response) =>
  (async (input: RequestInfo | URL) => handler(new URL(String(input)))) as typeof fetch;

const run = (fetchImpl: typeof fetch, cursors: { costs?: string | null; usage?: string | null } = {}) =>
  importAnthropicUsageAndCosts({
    workspaceId: "ws-1",
    actorId: "user-1",
    connectionKey: "anthropic-main",
    request: {
      token: TOKEN,
      instanceUrl: "",
      fetchImpl,
      start: new Date(START),
      end: new Date(START + PAGES * DAY),
      cursor: cursors.costs ?? null,
    },
    usageCursor: cursors.usage ?? null,
  });

beforeEach(() => {
  costs.rows.clear();
  usage.rows.clear();
  auditMock.mockClear();
});

describe("importAnthropicUsageAndCosts", () => {
  it("imports usage and costs, reconciles with the organization total and returns the warnings", async () => {
    const result = await run(fetchFrom(anthropic));

    expect(result).toMatchObject({
      linesImported: 6,
      usageLinesImported: 3,
      stoppedBy: null,
      usageStoppedBy: null,
      nextCursor: null,
      usageNextCursor: null,
    });
    expect(result.reconciliation).toEqual({
      status: "RECONCILED",
      currencies: [{ currency: "USD", imported: "0.15", provider: "0.15", difference: "0", withinTolerance: true }],
    });
    expect(result.warnings).toEqual([
      { code: "PRIORITY_TIER_NOT_PRICED", count: 3 },
      { code: "USAGE_WITHOUT_MODEL", count: 3 },
    ]);
    expect(usage.rows.size).toBe(3);
    expect([...usage.rows.values()][0]).toMatchObject({ provider: "ANTHROPIC", inputTokens: BigInt(100), outputTokens: BigInt(10) });
  });

  it("creates nothing new when the same window is imported again", async () => {
    await run(fetchFrom(anthropic));
    await run(fetchFrom(anthropic));

    expect(costs.rows.size).toBe(6);
    expect(usage.rows.size).toBe(3);
  });

  it("attaches the warnings to the sync run's audit entry, as codes and counts only", async () => {
    await run(fetchFrom(anthropic));

    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "integration.sync",
        outcome: "SUCCESS",
        metadata: expect.objectContaining({
          provider: "ANTHROPIC",
          usageLines: 3,
          warnings: 2,
          warn_PRIORITY_TIER_NOT_PRICED: 3,
          warn_USAGE_WITHOUT_MODEL: 3,
        }),
      }),
    );
    const serialized = JSON.stringify(auditMock.mock.calls);
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain("0.15");
  });

  it("stores what was read before a rate limit, does not reconcile, and resumes both listings", async () => {
    const partial = await run(
      fetchFrom((url) => (pageIndex(url) > 0 ? json({}, 429, { "retry-after": "30" }) : anthropic(url))),
    );

    expect(partial).toMatchObject({
      linesImported: 2,
      stoppedBy: "RATE_LIMITED",
      nextCursor: "page_2",
      usageLinesImported: 1,
      usageStoppedBy: "RATE_LIMITED",
      usageNextCursor: "page_2",
    });
    expect(partial.reconciliation.status).toBe("INCOMPLETE");

    const resumed = await run(fetchFrom(anthropic), { costs: partial.nextCursor, usage: partial.usageNextCursor });
    expect(costs.rows.size).toBe(6);
    expect(usage.rows.size).toBe(3);
    expect(resumed.reconciliation.status).toBe("RECONCILED");
  });

  it("returns an empty run with a NO_DATA_YET warning, not a zero month", async () => {
    const result = await run(fetchFrom(() => json({ data: [], has_more: false, next_page: null, data_refreshed_at: null })));

    expect(result).toMatchObject({ linesImported: 0, usageLinesImported: 0 });
    expect(result.warnings).toEqual([{ code: "NO_DATA_YET", count: null }]);
  });

  it("reports a mismatch when stored lines and the provider total disagree", async () => {
    const result = await importAnthropicUsageAndCosts(
      {
        workspaceId: "ws-1",
        actorId: null,
        connectionKey: "anthropic-main",
        request: { token: TOKEN, instanceUrl: "", fetchImpl: fetchFrom(anthropic), start: new Date(START), end: new Date(START + PAGES * DAY), cursor: null },
      },
      { organizationTotals: async () => ({ totals: new Map([["USD", new Decimal("0.20")]]), complete: true }) },
    );

    expect(result.reconciliation.status).toBe("MISMATCH");
    expect(result.reconciliation.currencies[0].difference).toBe("-0.05");
  });

  it("stores nothing and audits a failure on a revoked key", async () => {
    await expect(run(fetchFrom(() => json({ type: "error" }, 401)))).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    expect(costs.rows.size + usage.rows.size).toBe(0);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "FAILED", metadata: expect.objectContaining({ error: "UNAUTHORIZED" }) }),
    );
  });
});
