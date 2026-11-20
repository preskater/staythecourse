import { describe, expect, it } from "vitest";
import type { AiPageRequest } from "./ai-adapter";
import { describeAiAdapterContract } from "./ai-adapter.contract";
import { CURSOR_WARNINGS, cursorAdapter, listCursorTotals } from "./cursor";

/**
 * Cursor responses are simulated from the shapes of the Admin API reference
 * (`GET /v2/teams/billing-items`, `GET /teams/members`). No test reaches Cursor and
 * the Team API key below is fictitious.
 */

const TOKEN = "key_fictitious_cursor_team_key";
const START = Date.UTC(2026, 9, 1);
const DAY = 86_400_000;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const tokens = { "prompt-text-tokens": "1000", "cached-prompt-text-tokens": "300", "cache-write-text-tokens": "50", "completion-text-tokens": "200", requests: "1" };

/** Three pages, cursors `c2` and `c3`. */
const PAGES: Record<string, unknown>[][] = [
  [
    {
      billingItemId: "11111111-0000-0000-0000-000000000001",
      eventTime: "2026-10-02T14:03:27.512Z",
      product: "cursor",
      chargeCategory: "usage",
      usageType: "on_demand",
      principal: { type: "user", id: "user_alice" },
      usage: tokens,
      pricing: { currency: "USD", contracted: "0.0125000000" },
      displayExtras: { model: "claude-x", userEmail: "alice@example.test" },
    },
    {
      billingItemId: "11111111-0000-0000-0000-000000000002",
      eventTime: "2026-10-02T15:00:00.000Z",
      product: "cursor",
      chargeCategory: "usage",
      usageType: "included",
      principal: { type: "user", id: "user_bob" },
      usage: tokens,
      pricing: { currency: "USD", contracted: "0.0000000000" },
      displayExtras: { model: "gpt-x" },
    },
  ],
  [
    {
      billingItemId: "11111111-0000-0000-0000-000000000003",
      eventTime: "2026-10-03T00:00:00.000Z",
      chargeCategory: "credit",
      usageType: "credits",
      principal: { type: "team", id: "team_1" },
      pricing: { currency: "USD", contracted: "-5.0000000000" },
    },
  ],
  [
    {
      // Token usage Cursor does not attribute to a model.
      billingItemId: "11111111-0000-0000-0000-000000000004",
      eventTime: "2026-10-04T09:00:00.000Z",
      chargeCategory: "usage",
      usageType: "on_demand",
      principal: { type: "user", id: "user_alice" },
      usage: { "prompt-text-tokens": "10", "completion-text-tokens": "5" },
      pricing: { currency: "USD", contracted: "0.0010000000" },
    },
  ],
];

const pageIndex = (url: URL) => {
  const cursor = url.searchParams.get("cursor");
  return cursor ? Number(cursor.slice(1)) - 1 : 0;
};

function healthyResponse(url: URL): Response {
  switch (url.pathname) {
    case "/teams/members":
      return json({
        teamMembers: [
          { id: "user_alice", name: "Alice", email: "alice@example.test", role: "owner", isRemoved: false },
          { id: "user_bob", name: "", email: "bob@example.test", role: "member", isRemoved: true },
        ],
      });
    case "/v2/teams/billing-items": {
      const index = pageIndex(url);
      const hasMore = index < PAGES.length - 1;
      return json({ data: PAGES[index], pagination: hasMore ? { hasMore, nextCursor: `c${index + 2}` } : { hasMore } });
    }
    default:
      return json({ code: "not_found", message: "Not found" }, 404);
  }
}

type Call = { url: URL; headers: Headers };

function recordingFetch(handler: (url: URL) => Response) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, headers: new Headers(init?.headers) });
    return handler(url);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const transport = (handler: (url: URL) => Response) => () => recordingFetch(handler).fetchImpl;
const rateLimited = () => json({ code: "rate_limited", message: "Too many requests" }, 429, { "retry-after": "30" });

describeAiAdapterContract({
  name: "cursor",
  adapter: cursorAdapter,
  token: TOKEN,
  instanceUrl: "",
  transports: {
    healthy: transport(healthyResponse),
    revoked: transport(() => json({ code: "unauthorized", message: "Invalid API key" }, 401)),
    forbidden: transport(() => json({ code: "forbidden", message: "Forbidden" }, 403)),
    rateLimited: transport(rateLimited),
    rateLimitedAfterFirstPage: transport((url) => (pageIndex(url) > 0 ? rateLimited() : healthyResponse(url))),
    malformed: transport(() => json({ unexpected: true })),
  },
});

const request = (fetchImpl: typeof fetch, extra: Partial<AiPageRequest> = {}): AiPageRequest => ({
  token: TOKEN,
  instanceUrl: "",
  fetchImpl,
  start: new Date(START),
  end: new Date(START + 31 * DAY),
  cursor: null,
  ...extra,
});

describe("cursorAdapter.listCosts", () => {
  it("imports every billed item as an exact USD line, credits included, keyed by its id", async () => {
    const { fetchImpl } = recordingFetch(healthyResponse);
    const outcome = await cursorAdapter.listCosts(request(fetchImpl));

    expect(outcome.records.map(({ externalId, scopeId, model, amount, dimensions }) => ({ externalId, scopeId, model, amount, dimensions }))).toEqual([
      {
        externalId: "11111111-0000-0000-0000-000000000001",
        scopeId: "user_alice",
        model: "claude-x",
        amount: "0.0125",
        dimensions: { product: "cursor", usageType: "on_demand", chargeCategory: "usage", principalType: "user" },
      },
      {
        externalId: "11111111-0000-0000-0000-000000000002",
        scopeId: "user_bob",
        model: "gpt-x",
        amount: "0",
        dimensions: { product: "cursor", usageType: "included", chargeCategory: "usage", principalType: "user" },
      },
      {
        externalId: "11111111-0000-0000-0000-000000000003",
        scopeId: "team_1",
        model: null,
        amount: "-5",
        dimensions: { usageType: "credits", chargeCategory: "credit", principalType: "team" },
      },
      {
        externalId: "11111111-0000-0000-0000-000000000004",
        scopeId: "user_alice",
        model: null,
        amount: "0.001",
        dimensions: { usageType: "on_demand", chargeCategory: "usage", principalType: "user" },
      },
    ]);
    expect(outcome.records[0]).toMatchObject({
      currency: "USD",
      periodStart: new Date("2026-10-02T14:03:27.512Z"),
      periodEnd: new Date("2026-10-02T14:03:27.513Z"),
    });
    // Included usage priced at zero: the plan fee pays for it, outside this data.
    expect(outcome.warnings).toEqual([{ code: CURSOR_WARNINGS.PLAN_USAGE_NOT_PRICED, count: 1 }]);
  });

  it("never stores the member's email", async () => {
    const { fetchImpl } = recordingFetch(healthyResponse);
    const outcome = await cursorAdapter.listCosts(request(fetchImpl));
    expect(JSON.stringify(outcome)).not.toContain("@example.test");
  });

  it("asks for the window in RFC 3339 with the key in a Basic header, never in the URL", async () => {
    const { calls, fetchImpl } = recordingFetch(healthyResponse);
    await cursorAdapter.listCosts(request(fetchImpl, { maxPages: 1 }));

    const { url, headers } = calls[0];
    expect(url.origin + url.pathname).toBe("https://api.cursor.com/v2/teams/billing-items");
    expect(url.searchParams.get("startTime")).toBe("2026-10-01T00:00:00Z");
    expect(url.searchParams.get("endTime")).toBe("2026-11-01T00:00:00Z");
    expect(headers.get("authorization")).toBe(`Basic ${Buffer.from(`${TOKEN}:`).toString("base64")}`);
    expect(url.toString()).not.toContain(TOKEN);
  });

  it("returns a complete, empty outcome for a window without billed items", async () => {
    const { fetchImpl } = recordingFetch(() => json({ data: [], pagination: { hasMore: false } }));
    const outcome = await cursorAdapter.listCosts(request(fetchImpl));
    expect(outcome).toMatchObject({ records: [], stoppedBy: null, nextCursor: null, pagesRead: 1 });
    expect(outcome.warnings).toBeUndefined();
  });

  it.each([
    ["hasMore without a cursor", { data: [], pagination: { hasMore: true } }],
    ["an amount sent as a number", { data: [{ ...PAGES[0][0], pricing: { currency: "USD", contracted: 0.0125 } }], pagination: { hasMore: false } }],
    ["a meter that is not a whole number", { data: [{ ...PAGES[0][0], usage: { "prompt-text-tokens": "1.5" } }], pagination: { hasMore: false } }],
  ])("rejects %s as INVALID_RESPONSE", async (_label, body) => {
    const { fetchImpl } = recordingFetch(() => json(body));
    await expect(cursorAdapter.listUsage!(request(fetchImpl))).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("refuses a window longer than 31 days before any request", async () => {
    const { calls, fetchImpl } = recordingFetch(healthyResponse);
    await expect(cursorAdapter.listCosts(request(fetchImpl, { end: new Date(START + 32 * DAY) }))).rejects.toThrow(RangeError);
    expect(calls).toHaveLength(0);
  });
});

describe("cursorAdapter.listUsage", () => {
  it("imports token items with a model; input sums the three separately priced input meters", async () => {
    const { fetchImpl } = recordingFetch(healthyResponse);
    const outcome = await cursorAdapter.listUsage!(request(fetchImpl));

    expect(outcome.records).toEqual([
      expect.objectContaining({
        externalId: "11111111-0000-0000-0000-000000000001",
        scopeId: "user_alice",
        model: "claude-x",
        inputTokens: 1350,
        outputTokens: 200,
        cachedInputTokens: 300,
        reasoningTokens: null,
        requests: 1,
      }),
      expect.objectContaining({ externalId: "11111111-0000-0000-0000-000000000002", model: "gpt-x" }),
    ]);
    // The credit has no usage; the token item without a model is counted, not guessed.
    expect(outcome.warnings).toEqual([{ code: CURSOR_WARNINGS.USAGE_WITHOUT_MODEL, count: 1 }]);
  });
});

describe("cursorAdapter.discover", () => {
  it("lists members, removed ones included, by id and name, never by email", async () => {
    const { fetchImpl } = recordingFetch(healthyResponse);
    const discovery = await cursorAdapter.discover({ token: TOKEN, instanceUrl: "", fetchImpl });

    expect(discovery.scopes).toEqual([
      { externalId: "user_alice", name: "Alice", kind: "member" },
      { externalId: "user_bob", name: "user_bob", kind: "member" },
    ]);
  });
});

describe("listCursorTotals", () => {
  it("has no independent total, so the reconciliation stays incomplete", async () => {
    expect(await listCursorTotals()).toEqual({ totals: new Map(), complete: false });
  });
});
