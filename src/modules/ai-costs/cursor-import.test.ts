import Decimal from "decimal.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Cursor team usage and spend import (M11-07), end to end from a fake `fetch` to fake
 * tables honouring the unique key `(workspaceId, connectionKey, externalId)` the way
 * PostgreSQL would. No test reaches Cursor or a database; the key is fictitious.
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
    groupBy: vi.fn(async () => {
      const sums = new Map<string, Decimal>();
      for (const row of costs.rows.values()) {
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

const { importCursorUsageAndCosts } = await import("./cursor-import");

const TOKEN = "key_fictitious_cursor_team_key";
const START = Date.UTC(2026, 9, 1);
const DAY = 86_400_000;
const PAGES = 3;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const pageIndex = (url: URL) => {
  const cursor = url.searchParams.get("cursor");
  return cursor ? Number(cursor.slice(1)) - 1 : 0;
};

/** Each page: one on-demand item and one included item priced at zero. */
function cursor(url: URL): Response {
  const index = pageIndex(url);
  const item = (n: number, usageType: string, contracted: string) => ({
    billingItemId: `item-${index}-${n}`,
    eventTime: new Date(START + index * DAY + n * 1000).toISOString(),
    chargeCategory: "usage",
    usageType,
    principal: { type: "user", id: `user_${n}` },
    usage: { "prompt-text-tokens": "100", "completion-text-tokens": "20", requests: "1" },
    pricing: { currency: "USD", contracted },
    displayExtras: { model: "claude-x", userEmail: `member${n}@example.test` },
  });
  const hasMore = index < PAGES - 1;
  return json({
    data: [item(0, "on_demand", "0.0200000000"), item(1, "included", "0.0000000000")],
    pagination: hasMore ? { hasMore, nextCursor: `c${index + 2}` } : { hasMore },
  });
}

const fetchFrom = (handler: (url: URL) => Response) =>
  (async (input: RequestInfo | URL) => handler(new URL(String(input)))) as typeof fetch;

const run = (fetchImpl: typeof fetch, cursors: { costs?: string | null; usage?: string | null } = {}) =>
  importCursorUsageAndCosts({
    workspaceId: "ws-1",
    actorId: "user-1",
    connectionKey: "cursor-team",
    request: { token: TOKEN, instanceUrl: "", fetchImpl, start: new Date(START), end: new Date(START + 10 * DAY), cursor: cursors.costs ?? null },
    usageCursor: cursors.usage ?? null,
  });

beforeEach(() => {
  costs.rows.clear();
  usage.rows.clear();
  auditMock.mockClear();
});

describe("importCursorUsageAndCosts", () => {
  it("imports every item and says the plan fee is not in the data", async () => {
    const result = await run(fetchFrom(cursor));

    expect(result).toMatchObject({ linesImported: 6, usageLinesImported: 6, stoppedBy: null, usageStoppedBy: null });
    expect(result.warnings).toEqual([{ code: "PLAN_USAGE_NOT_PRICED", count: 3 }]);
    // No independent total exists for a window: never claimed reconciled.
    expect(result.reconciliation.status).toBe("INCOMPLETE");
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "SUCCESS", metadata: expect.objectContaining({ provider: "CURSOR", warn_PLAN_USAGE_NOT_PRICED: 3 }) }),
    );
  });

  it("creates nothing new when the same window is imported again", async () => {
    await run(fetchFrom(cursor));
    await run(fetchFrom(cursor));

    expect(costs.rows.size).toBe(6);
    expect(usage.rows.size).toBe(6);
  });

  it("stores no member email, only the member's opaque id", async () => {
    await run(fetchFrom(cursor));

    const stored = JSON.stringify([...costs.rows.values(), ...usage.rows.values(), auditMock.mock.calls], (_key, value) =>
      typeof value === "bigint" ? value.toString() : value,
    );
    expect(stored).not.toContain("@example.test");
    expect([...costs.rows.values()].map((row) => row.scopeId)).toContain("user_0");
  });

  it("stores the first page before a rate limit and resumes from its cursor", async () => {
    const partial = await run(fetchFrom((url) => (pageIndex(url) > 0 ? json({}, 429, { "retry-after": "60" }) : cursor(url))));

    expect(partial).toMatchObject({ linesImported: 2, stoppedBy: "RATE_LIMITED", nextCursor: "c2" });
    await run(fetchFrom(cursor), { costs: partial.nextCursor, usage: partial.usageNextCursor });
    expect(costs.rows.size).toBe(6);
    expect(usage.rows.size).toBe(6);
  });

  it("imports nothing for a window without billed items", async () => {
    const result = await run(fetchFrom(() => json({ data: [], pagination: { hasMore: false } })));
    expect(result).toMatchObject({ linesImported: 0, usageLinesImported: 0, warnings: [] });
  });

  it("stores nothing and audits a failure on a revoked key, without leaking it", async () => {
    await expect(run(fetchFrom(() => json({ code: "unauthorized" }, 401)))).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    expect(costs.rows.size + usage.rows.size).toBe(0);
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ outcome: "FAILED", metadata: expect.objectContaining({ error: "UNAUTHORIZED" }) }));
    expect(JSON.stringify(auditMock.mock.calls)).not.toContain(TOKEN);
  });
});
