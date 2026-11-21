import Decimal from "decimal.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * OpenRouter usage and spend import (M11-04), end to end from a fake `fetch` to fake
 * tables honouring the unique key `(workspaceId, connectionKey, externalId)` the way
 * PostgreSQL would. No test reaches OpenRouter or a database; the key is fictitious.
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

const { importOpenRouterUsageAndCosts } = await import("./openrouter-import");

const TOKEN = "fake-openrouter-management-key";
const KEY_HASH = "b".repeat(64);
const DAY = 86_400_000;
const START = Date.UTC(2026, 9, 1);
const DAYS = 10;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const ENDPOINT = { model: "anthropic/claude-x", model_permaslug: "anthropic/claude-x-2026", endpoint_id: "33333333-3333-3333-3333-333333333333", provider_name: "Anthropic" };

/** Each day: 0.05 USD in total, 0.03 of it through the listed key, 0.02 through no listed key. */
function activity(keyHash: string | null) {
  return Array.from({ length: DAYS }, (_, index) => ({
    date: new Date(START + index * DAY).toISOString().slice(0, 10),
    ...ENDPOINT,
    usage: keyHash ? 0.03 : 0.05,
    byok_usage_inference: 0,
    requests: keyHash ? 3 : 5,
    prompt_tokens: keyHash ? 600 : 1000,
    completion_tokens: keyHash ? 120 : 200,
    reasoning_tokens: 0,
    cached_tokens: keyHash ? 200 : 300,
  }));
}

function openRouter(url: URL): Response {
  if (url.pathname === "/api/v1/keys") {
    return json({ data: url.searchParams.get("offset") === "0" ? [{ hash: KEY_HASH, name: "Agent support", workspace_id: "ws-uuid-1" }] : [] });
  }
  if (url.pathname === "/api/v1/activity") return json({ data: activity(url.searchParams.get("api_key_hash")) });
  return json({}, 404);
}

const fetchFrom = (handler: (url: URL) => Response) =>
  (async (input: RequestInfo | URL) => handler(new URL(String(input)))) as typeof fetch;

const run = (fetchImpl: typeof fetch, cursors: { costs?: string | null; usage?: string | null } = {}) =>
  importOpenRouterUsageAndCosts({
    workspaceId: "ws-1",
    actorId: "user-1",
    connectionKey: "openrouter-main",
    request: { token: TOKEN, instanceUrl: "", fetchImpl, start: new Date(START), end: new Date(START + DAYS * DAY), cursor: cursors.costs ?? null },
    usageCursor: cursors.usage ?? null,
  });

beforeEach(() => {
  // Within the 30 days OpenRouter keeps, after the window: no window warning.
  vi.useFakeTimers({ now: new Date("2026-10-20T12:00:00Z"), toFake: ["Date"] });
  costs.rows.clear();
  usage.rows.clear();
  auditMock.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("importOpenRouterUsageAndCosts", () => {
  it("imports per-key and unattributed lines, and reconciles with the account spend", async () => {
    const result = await run(fetchFrom(openRouter));

    expect(result).toMatchObject({ linesImported: 2 * DAYS, usageLinesImported: 2 * DAYS, stoppedBy: null, usageStoppedBy: null });
    expect(result.reconciliation).toEqual({
      status: "RECONCILED",
      currencies: [{ currency: "USD", imported: "0.5", provider: "0.5", difference: "0", withinTolerance: true }],
    });
    expect(result.warnings).toEqual([{ code: "UNATTRIBUTED_USAGE", count: 2 * DAYS }]);
  });

  it("keeps usage of no listed key unattributed: no scope, no key dimension", async () => {
    await run(fetchFrom(openRouter));

    const unattributed = [...costs.rows.values()].filter((row) => row.scopeId === null);
    expect(unattributed).toHaveLength(DAYS);
    for (const row of unattributed) {
      expect((row.amount as Decimal).toFixed()).toBe("0.02");
      expect(row.dimensions).not.toHaveProperty("apiKeyId");
    }
    const tokenClasses = [...usage.rows.values()].find((row) => row.scopeId === KEY_HASH)!;
    expect(tokenClasses).toMatchObject({ cachedInputTokens: BigInt(200), reasoningTokens: BigInt(0) });
  });

  it("creates nothing new when the same window is imported again", async () => {
    await run(fetchFrom(openRouter));
    await run(fetchFrom(openRouter));

    expect(costs.rows.size).toBe(2 * DAYS);
    expect(usage.rows.size).toBe(2 * DAYS);
  });

  it("stores the first week before a rate limit, does not reconcile, and resumes", async () => {
    let activityReads = 0;
    const limited = fetchFrom((url) =>
      url.pathname === "/api/v1/activity" && ++activityReads > 2 ? json({}, 429, { "retry-after": "30" }) : openRouter(url),
    );
    const partial = await run(limited);

    expect(partial).toMatchObject({ linesImported: 14, stoppedBy: "RATE_LIMITED", nextCursor: "2026-10-08" });
    // Usage, still throttled, is postponed to the next run rather than failing this one.
    expect(partial).toMatchObject({ usageLinesImported: 0, usageStoppedBy: "RATE_LIMITED", usageNextCursor: null });
    expect(partial.reconciliation.status).toBe("INCOMPLETE");

    const resumed = await run(fetchFrom(openRouter), { costs: partial.nextCursor, usage: partial.usageNextCursor });
    expect(costs.rows.size).toBe(2 * DAYS);
    expect(usage.rows.size).toBe(2 * DAYS);
    expect(resumed.reconciliation.status).toBe("RECONCILED");
  });

  it("imports nothing, and reconciles zero with zero, when there is no activity", async () => {
    const result = await run(fetchFrom((url) => (url.pathname === "/api/v1/activity" ? json({ data: [] }) : openRouter(url))));

    expect(result).toMatchObject({ linesImported: 0, usageLinesImported: 0, warnings: [] });
    expect(result.reconciliation.status).toBe("RECONCILED");
  });

  it("stores nothing and audits a failure on a revoked key, without leaking it", async () => {
    await expect(run(fetchFrom(() => json({ error: { code: 401 } }, 401)))).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    expect(costs.rows.size + usage.rows.size).toBe(0);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "FAILED", metadata: expect.objectContaining({ provider: "OPENROUTER", error: "UNAUTHORIZED" }) }),
    );
    const serialized = JSON.stringify(auditMock.mock.calls);
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain(KEY_HASH);
  });
});
