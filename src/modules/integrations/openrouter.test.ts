import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiPageRequest } from "./ai-adapter";
import { describeAiAdapterContract } from "./ai-adapter.contract";
import { listOpenRouterTotals, OPENROUTER_WARNINGS, openRouterAdapter } from "./openrouter";

/**
 * OpenRouter responses are simulated from the shapes of the public API reference
 * (`GET /activity`, `GET /keys`, `GET /key`). No test reaches OpenRouter and the
 * management key below is fictitious.
 */

const TOKEN = "fake-openrouter-management-key";
const KEY_HASH = "a".repeat(64);
const DAY = 86_400_000;
const START = Date.UTC(2026, 9, 1);

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const date = (index: number) => new Date(START + index * DAY).toISOString().slice(0, 10);

const activity = (day: string, endpoint: Record<string, unknown>, metrics: Record<string, number>) => ({
  date: day,
  model_permaslug: `${endpoint.model}-2026`,
  ...endpoint,
  ...metrics,
});

const CLAUDE = { model: "anthropic/claude-x", endpoint_id: "11111111-1111-1111-1111-111111111111", provider_name: "Anthropic" };
const BYOK = { model: "openai/gpt-x", endpoint_id: "22222222-2222-2222-2222-222222222222", provider_name: "OpenAI" };

/** Every day of October: the total, and the share of the one listed key. */
function rows(keyHash: string | null) {
  return Array.from({ length: 31 }, (_, index) => {
    const day = date(index);
    return keyHash === null
      ? [
          activity(day, CLAUDE, { usage: 0.05, byok_usage_inference: 0, requests: 5, prompt_tokens: 1000, completion_tokens: 200, reasoning_tokens: 50, cached_tokens: 300 }),
          activity(day, BYOK, { usage: 0, byok_usage_inference: 0.5, requests: 1, prompt_tokens: 10, completion_tokens: 5, reasoning_tokens: 0, cached_tokens: 0 }),
        ]
      : [
          activity(day, CLAUDE, { usage: 0.03, byok_usage_inference: 0, requests: 3, prompt_tokens: 600, completion_tokens: 120, reasoning_tokens: 30, cached_tokens: 200 }),
          activity(day, BYOK, { usage: 0, byok_usage_inference: 0.5, requests: 1, prompt_tokens: 10, completion_tokens: 5, reasoning_tokens: 0, cached_tokens: 0 }),
        ];
  }).flat();
}

function healthyResponse(url: URL): Response {
  switch (url.pathname) {
    case "/api/v1/key":
      return json({ data: { label: "sk-or-v1-abc...123", is_management_key: true, usage: 1.5 } });
    case "/api/v1/keys":
      return json({
        data:
          url.searchParams.get("offset") === "0"
            ? [{ hash: KEY_HASH, name: "Agent support", label: "sk-or-v1-0e6...1c96", disabled: false, workspace_id: "ws-uuid-1" }]
            : [],
      });
    case "/api/v1/activity":
      return json({ data: rows(url.searchParams.get("api_key_hash")) });
    default:
      return json({ error: { code: 404, message: "Not Found" } }, 404);
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
const rateLimited = () => json({ error: { code: 429, message: "Rate limit exceeded" } }, 429, { "retry-after": "30" });

/** The first page reads the activity twice (total, one key); every later read is refused. */
function rateLimitedAfterFirstPage() {
  let activityReads = 0;
  return recordingFetch((url) => {
    if (url.pathname === "/api/v1/activity" && ++activityReads > 2) return rateLimited();
    return healthyResponse(url);
  }).fetchImpl;
}

describeAiAdapterContract({
  name: "openrouter",
  adapter: openRouterAdapter,
  token: TOKEN,
  instanceUrl: "",
  transports: {
    healthy: transport(healthyResponse),
    revoked: transport(() => json({ error: { code: 401, message: "Missing Authentication header" } }, 401)),
    forbidden: transport(() => json({ error: { code: 403, message: "Only management keys can perform this operation" } }, 403)),
    rateLimited: transport(rateLimited),
    rateLimitedAfterFirstPage,
    malformed: transport(() => json({ unexpected: true })),
  },
});

const request = (fetchImpl: typeof fetch, extra: Partial<AiPageRequest> = {}): AiPageRequest => ({
  token: TOKEN,
  instanceUrl: "",
  fetchImpl,
  start: new Date(START),
  end: new Date(START + DAY),
  cursor: null,
  ...extra,
});

describe("openRouterAdapter", () => {
  // Inside the 30 days OpenRouter keeps, and after the window: no window warning.
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date("2026-10-20T12:00:00Z"), toFake: ["Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("attributes usage to the listed key and keeps the rest as usage of no key", async () => {
    const { fetchImpl } = recordingFetch(healthyResponse);
    const outcome = await openRouterAdapter.listUsage!(request(fetchImpl));

    const day = { periodStart: new Date(START), periodEnd: new Date(START + DAY) };
    expect(outcome.records).toEqual([
      {
        externalId: `2026-10-01|anthropic/claude-x|${CLAUDE.endpoint_id}|${KEY_HASH}`,
        scopeId: KEY_HASH,
        model: "anthropic/claude-x",
        ...day,
        inputTokens: 600,
        outputTokens: 120,
        cachedInputTokens: 200,
        reasoningTokens: 30,
        requests: 3,
        dimensions: { provider: "Anthropic", endpointId: CLAUDE.endpoint_id, apiKeyId: KEY_HASH, workspaceId: "ws-uuid-1" },
      },
      {
        externalId: `2026-10-01|openai/gpt-x|${BYOK.endpoint_id}|${KEY_HASH}`,
        scopeId: KEY_HASH,
        model: "openai/gpt-x",
        ...day,
        inputTokens: 10,
        outputTokens: 5,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        requests: 1,
        dimensions: { provider: "OpenAI", endpointId: BYOK.endpoint_id, apiKeyId: KEY_HASH, workspaceId: "ws-uuid-1" },
      },
      {
        // Unknown key: no `apiKeyId`, no scope. Never guessed.
        externalId: `2026-10-01|anthropic/claude-x|${CLAUDE.endpoint_id}|`,
        scopeId: null,
        model: "anthropic/claude-x",
        ...day,
        inputTokens: 400,
        outputTokens: 80,
        cachedInputTokens: 100,
        reasoningTokens: 20,
        requests: 2,
        dimensions: { provider: "Anthropic", endpointId: CLAUDE.endpoint_id },
      },
    ]);
    expect(outcome.warnings).toEqual([
      { code: OPENROUTER_WARNINGS.UNATTRIBUTED_USAGE, count: 1 },
      { code: OPENROUTER_WARNINGS.BYOK_SPEND_NOT_IMPORTED, count: 1 },
    ]);
  });

  it("imports OpenRouter spend as exact USD, never the BYOK spend", async () => {
    const { fetchImpl } = recordingFetch(healthyResponse);
    const outcome = await openRouterAdapter.listCosts(request(fetchImpl));

    expect(outcome.records.map(({ scopeId, model, amount, currency }) => ({ scopeId, model, amount, currency }))).toEqual([
      { scopeId: KEY_HASH, model: "anthropic/claude-x", amount: "0.03", currency: "USD" },
      { scopeId: KEY_HASH, model: "openai/gpt-x", amount: "0", currency: "USD" },
      { scopeId: null, model: "anthropic/claude-x", amount: "0.02", currency: "USD" },
    ]);
  });

  it("reads the total and each key with the management key in a header, keys including disabled and expired", async () => {
    const { calls, fetchImpl } = recordingFetch(healthyResponse);
    await openRouterAdapter.listCosts(request(fetchImpl));

    const keys = calls.find((call) => call.url.pathname === "/api/v1/keys")!;
    expect(keys.url.searchParams.get("include_disabled")).toBe("true");
    expect(keys.url.searchParams.get("include_expired")).toBe("true");
    const activities = calls.filter((call) => call.url.pathname === "/api/v1/activity");
    expect(activities.map((call) => call.url.searchParams.get("api_key_hash"))).toEqual([null, KEY_HASH]);
    for (const call of calls) {
      expect(call.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
      expect(call.url.toString()).not.toContain(TOKEN);
    }
  });

  it("pages by weeks and resumes on a day boundary", async () => {
    const { fetchImpl } = recordingFetch(healthyResponse);
    const first = await openRouterAdapter.listCosts(request(fetchImpl, { end: new Date(START + 10 * DAY), maxPages: 1 }));

    expect(first).toMatchObject({ stoppedBy: "MAX_PAGES", nextCursor: "2026-10-08", pagesRead: 1 });
    expect(new Set(first.records.map((record) => record.periodStart.toISOString().slice(0, 10)))).toEqual(
      new Set(["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07"]),
    );

    const rest = await openRouterAdapter.listCosts(request(fetchImpl, { end: new Date(START + 10 * DAY), cursor: first.nextCursor }));
    expect(rest).toMatchObject({ stoppedBy: null, nextCursor: null });
    expect(first.records.length + rest.records.length).toBe(30);
  });

  it("returns a complete, empty outcome when there is no activity", async () => {
    const { fetchImpl } = recordingFetch((url) => (url.pathname === "/api/v1/activity" ? json({ data: [] }) : healthyResponse(url)));
    const outcome = await openRouterAdapter.listCosts(request(fetchImpl));

    expect(outcome).toMatchObject({ records: [], stoppedBy: null, nextCursor: null, pagesRead: 1 });
    expect(outcome.warnings).toBeUndefined();
  });

  it("warns when the window reaches past the 30 days kept or into today", async () => {
    vi.setSystemTime(new Date("2026-11-20T12:00:00Z"));
    const { fetchImpl } = recordingFetch((url) => (url.pathname === "/api/v1/activity" ? json({ data: [] }) : healthyResponse(url)));
    const outcome = await openRouterAdapter.listCosts(
      request(fetchImpl, { start: new Date(Date.UTC(2026, 9, 15)), end: new Date(Date.UTC(2026, 10, 21)) }),
    );

    expect(outcome.warnings).toEqual([
      { code: OPENROUTER_WARNINGS.OUTSIDE_RETENTION, count: null },
      { code: OPENROUTER_WARNINGS.CURRENT_DAY_NOT_REPORTED, count: null },
    ]);
  });

  it.each([
    ["a key reporting more than the total", (url: URL) =>
      url.searchParams.get("api_key_hash")
        ? json({ data: [activity(date(0), CLAUDE, { usage: 1, byok_usage_inference: 0, requests: 99, prompt_tokens: 1, completion_tokens: 1, reasoning_tokens: 0, cached_tokens: 0 })] })
        : healthyResponse(url)],
    ["an amount sent as text", (url: URL) =>
      url.pathname === "/api/v1/activity"
        ? json({ data: [{ ...activity(date(0), CLAUDE, { byok_usage_inference: 0, requests: 1, prompt_tokens: 1, completion_tokens: 1, reasoning_tokens: 0, cached_tokens: 0 }), usage: "0.05" }] })
        : healthyResponse(url)],
  ])("rejects %s as INVALID_RESPONSE", async (_label, handler) => {
    const { fetchImpl } = recordingFetch(handler);
    await expect(openRouterAdapter.listCosts(request(fetchImpl))).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("refuses a window not on UTC midnight before any request", async () => {
    const { calls, fetchImpl } = recordingFetch(healthyResponse);
    await expect(openRouterAdapter.listCosts(request(fetchImpl, { start: new Date(START + 3_600_000) }))).rejects.toThrow(RangeError);
    expect(calls).toHaveLength(0);
  });

  it("refuses a regular key in testAuth: activity needs a management key", async () => {
    const { fetchImpl } = recordingFetch(() => json({ data: { is_management_key: false } }));
    await expect(openRouterAdapter.testAuth({ token: TOKEN, instanceUrl: "", fetchImpl })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("discovers keys by hash and name, never by their masked label", async () => {
    const { fetchImpl } = recordingFetch(healthyResponse);
    const discovery = await openRouterAdapter.discover({ token: TOKEN, instanceUrl: "", fetchImpl });
    expect(discovery.scopes).toEqual([{ externalId: KEY_HASH, name: "Agent support", kind: "api_key" }]);
  });
});

describe("listOpenRouterTotals", () => {
  it("sums the unfiltered account spend of the window", async () => {
    const { calls, fetchImpl } = recordingFetch(healthyResponse);
    const totals = await listOpenRouterTotals(request(fetchImpl, { end: new Date(START + 3 * DAY) }));

    expect(calls.every((call) => !call.url.searchParams.has("api_key_hash"))).toBe(true);
    expect(totals).toEqual({ totals: new Map([["USD", expect.anything()]]), complete: true });
    expect(totals.totals.get("USD")?.toFixed()).toBe("0.15");
  });
});
