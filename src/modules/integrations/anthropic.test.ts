import { describe, expect, it } from "vitest";
import { ProviderError } from "./adapter";
import type { AiPageRequest } from "./ai-adapter";
import { describeAiAdapterContract } from "./ai-adapter.contract";
import {
  ANTHROPIC_ANALYTICS_BETA,
  ANTHROPIC_COST_GROUP_BY,
  ANTHROPIC_USAGE_GROUP_BY,
  ANTHROPIC_WARNINGS,
  anthropicAdapter,
  anthropicAmount,
  listAnthropicOrganizationTotals,
} from "./anthropic";

/**
 * Anthropic responses are simulated from the shapes documented for the Usage and Cost
 * Analytics API and the Admin API workspace list. No test reaches Anthropic and the
 * key below is fictitious.
 */

const TOKEN = "fake-anthropic-admin-key";
const DAY = 86_400_000;
const START = Date.UTC(2026, 9, 1);
const PAGES = 3;
const REFRESHED = "2026-11-15T00:00:00Z";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

/** Page index from the `page` cursor: `page_2` → 1. */
const pageIndex = (url: URL) => {
  const page = url.searchParams.get("page");
  return page ? Number(page.split("_")[1]) - 1 : 0;
};

const day = (index: number) => ({
  starting_at: new Date(START + index * DAY).toISOString().replace(".000Z", "Z"),
  ending_at: new Date(START + (index + 1) * DAY).toISOString().replace(".000Z", "Z"),
});

const usage = (input: number, output: number) => ({
  uncached_input_tokens: input,
  cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 10 },
  cache_read_input_tokens: 5,
  output_tokens: output,
  total_tokens: input + 15 + output,
  server_tool_use: { web_search_requests: 0 },
  requests: 4,
});

function usageRows(index: number) {
  return [
    { ...day(index), group: { model: "claude-x", workspace_id: "wrkspc_1", service_tier: "standard" }, usage: usage(100, 50) },
    { ...day(index), group: { model: "claude-x", workspace_id: null, service_tier: "priority" }, usage: usage(20, 5) },
    // Code execution: usage without a model.
    { ...day(index), group: { model: null, workspace_id: "wrkspc_1", service_tier: null }, usage: usage(0, 0) },
  ];
}

function costRows(index: number) {
  return [
    {
      ...day(index),
      group: { model: "claude-x", workspace_id: "wrkspc_1", service_tier: "standard", cost_type: "tokens", token_type: "output_tokens" },
      cost: { currency: "USD", amount: "4.000000", list_amount: "5.000000", requests: null },
    },
    {
      ...day(index),
      group: { model: null, workspace_id: "wrkspc_1", service_tier: null, cost_type: "code_execution", token_type: null },
      cost: { currency: "USD", amount: "1.000000", list_amount: "1.000000", requests: null },
    },
  ];
}

function analytics(url: URL, rows: (index: number) => unknown[], refreshed: string | null = REFRESHED): Response {
  const index = pageIndex(url);
  return json({
    data: rows(index),
    has_more: index < PAGES - 1,
    next_page: index < PAGES - 1 ? `page_${index + 2}` : null,
    data_refreshed_at: refreshed,
  });
}

function healthyResponse(url: URL): Response {
  switch (url.pathname) {
    case "/v1/organizations/workspaces":
      return json({ data: [{ id: "wrkspc_1", type: "workspace", name: "Production" }], has_more: false, first_id: "wrkspc_1", last_id: "wrkspc_1" });
    case "/v1/organizations/analytics/usage":
      return analytics(url, usageRows);
    case "/v1/organizations/analytics/cost":
      return url.searchParams.getAll("group_by[]").length > 0
        ? analytics(url, costRows)
        : analytics(url, (index) => [{ ...day(index), group: {}, cost: { currency: "USD", amount: "5.000000" } }]);
    default:
      return json({ type: "error", error: { type: "not_found_error" } }, 404);
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
const rateLimited = () => json({ type: "error", error: { type: "rate_limit_error" } }, 429, { "retry-after": "30" });

describeAiAdapterContract({
  name: "anthropic",
  adapter: anthropicAdapter,
  token: TOKEN,
  instanceUrl: "",
  transports: {
    healthy: transport(healthyResponse),
    revoked: transport(() => json({ type: "error", error: { type: "authentication_error" } }, 401)),
    forbidden: transport(() => json({ type: "error", error: { type: "permission_error" } }, 403)),
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
  end: new Date(START + PAGES * DAY),
  cursor: null,
  ...extra,
});

describe("anthropicAdapter.listUsage", () => {
  it("normalises a page: every input token, known dimensions only, unknown workspace kept null", async () => {
    const { fetchImpl } = recordingFetch(healthyResponse);
    const outcome = await anthropicAdapter.listUsage!(request(fetchImpl, { maxPages: 1 }));

    expect(outcome.records).toEqual([
      {
        externalId: "2026-10-01T00:00:00Z|claude-x|wrkspc_1|standard",
        scopeId: "wrkspc_1",
        model: "claude-x",
        periodStart: new Date(START),
        periodEnd: new Date(START + DAY),
        inputTokens: 115,
        outputTokens: 50,
        cachedInputTokens: 5,
        reasoningTokens: null,
        requests: 4,
        dimensions: { serviceTier: "standard" },
      },
      {
        externalId: "2026-10-01T00:00:00Z|claude-x||priority",
        scopeId: null,
        model: "claude-x",
        periodStart: new Date(START),
        periodEnd: new Date(START + DAY),
        inputTokens: 35,
        outputTokens: 5,
        cachedInputTokens: 5,
        reasoningTokens: null,
        requests: 4,
        dimensions: { serviceTier: "priority" },
      },
    ]);
  });

  it("turns unsupported categories into warnings instead of dropping them silently", async () => {
    const { fetchImpl } = recordingFetch(healthyResponse);
    const outcome = await anthropicAdapter.listUsage!(request(fetchImpl));

    expect(outcome.warnings).toEqual([
      { code: ANTHROPIC_WARNINGS.PRIORITY_TIER_NOT_PRICED, count: PAGES },
      { code: ANTHROPIC_WARNINGS.USAGE_WITHOUT_MODEL, count: PAGES },
    ]);
  });

  it("asks for daily, oldest-first rows with the beta header, the key in a header only", async () => {
    const { calls, fetchImpl } = recordingFetch(healthyResponse);
    await anthropicAdapter.listUsage!(request(fetchImpl, { maxPages: 1 }));

    const { url, headers } = calls[0];
    expect(url.origin + url.pathname).toBe("https://api.anthropic.com/v1/organizations/analytics/usage");
    expect(url.searchParams.get("starting_at")).toBe("2026-10-01T00:00:00Z");
    expect(url.searchParams.get("ending_at")).toBe("2026-10-04T00:00:00Z");
    expect(url.searchParams.get("time_bucket_width")).toBe("1d");
    expect(url.searchParams.get("order_by")).toBe("time");
    expect(url.searchParams.get("order")).toBe("asc");
    expect(url.searchParams.getAll("group_by[]")).toEqual([...ANTHROPIC_USAGE_GROUP_BY]);
    expect(headers.get("anthropic-beta")).toBe(ANTHROPIC_ANALYTICS_BETA);
    expect(headers.get("anthropic-version")).toBeTruthy();
    expect(headers.get("x-api-key")).toBe(TOKEN);
    expect(url.toString()).not.toContain(TOKEN);
  });
});

describe("anthropicAdapter.listCosts", () => {
  it("converts cents to an exact amount and keeps cost and token types as dimensions", async () => {
    const { calls, fetchImpl } = recordingFetch(healthyResponse);
    const outcome = await anthropicAdapter.listCosts(request(fetchImpl, { maxPages: 1 }));

    expect(calls[0].url.searchParams.getAll("group_by[]")).toEqual([...ANTHROPIC_COST_GROUP_BY]);
    expect(outcome.records).toEqual([
      {
        externalId: "2026-10-01T00:00:00Z|claude-x|wrkspc_1|standard|tokens|output_tokens",
        scopeId: "wrkspc_1",
        model: "claude-x",
        periodStart: new Date(START),
        periodEnd: new Date(START + DAY),
        amount: "0.04",
        currency: "USD",
        dimensions: { serviceTier: "standard", costType: "tokens", tokenType: "output_tokens" },
      },
      {
        // Code execution has no model, but its cost is authoritative: imported.
        externalId: "2026-10-01T00:00:00Z||wrkspc_1||code_execution|",
        scopeId: "wrkspc_1",
        model: null,
        periodStart: new Date(START),
        periodEnd: new Date(START + DAY),
        amount: "0.01",
        currency: "USD",
        dimensions: { costType: "code_execution" },
      },
    ]);
    expect(outcome.warnings).toBeUndefined();
  });

  it("imports an undocumented cost type, with a warning", async () => {
    const { fetchImpl } = recordingFetch((url) =>
      analytics(url, (index) =>
        index === 0
          ? [{ ...day(0), group: { cost_type: "new_thing" }, cost: { currency: "USD", amount: "1.000000" } }]
          : [],
      ),
    );
    const outcome = await anthropicAdapter.listCosts(request(fetchImpl));

    expect(outcome.records).toHaveLength(1);
    expect(outcome.warnings).toEqual([{ code: ANTHROPIC_WARNINGS.UNKNOWN_COST_TYPE, count: 1 }]);
  });

  it("says no data yet rather than zero spend when Anthropic has nothing for the window", async () => {
    const { fetchImpl } = recordingFetch(() => json({ data: [], has_more: false, next_page: null, data_refreshed_at: null }));
    const outcome = await anthropicAdapter.listCosts(request(fetchImpl));

    expect(outcome).toMatchObject({ records: [], stoppedBy: null, nextCursor: null, pagesRead: 1 });
    expect(outcome.warnings).toEqual([{ code: ANTHROPIC_WARNINGS.NO_DATA_YET, count: null }]);
  });

  it("flags a window whose last days are not refreshed yet", async () => {
    const { fetchImpl } = recordingFetch((url) => analytics(url, costRows, "2026-10-02T12:00:00Z"));
    const outcome = await anthropicAdapter.listCosts(request(fetchImpl));

    expect(outcome.warnings).toEqual([{ code: ANTHROPIC_WARNINGS.DATA_NOT_YET_REFRESHED, count: null }]);
  });

  it("restarts from the first page once when the stored cursor expired (HTTP 410)", async () => {
    const { calls, fetchImpl } = recordingFetch((url) =>
      url.searchParams.get("page") === "page_stale" ? json({}, 410) : healthyResponse(url),
    );
    const outcome = await anthropicAdapter.listCosts(request(fetchImpl, { cursor: "page_stale" }));

    expect(outcome.stoppedBy).toBeNull();
    expect(outcome.records).toHaveLength(2 * PAGES);
    expect(calls[1].url.searchParams.get("page")).toBeNull();
  });

  it.each([
    ["has_more without a cursor", { data: [], has_more: true, next_page: null, data_refreshed_at: REFRESHED }],
    ["rows without a refresh date", { data: costRows(0), has_more: false, next_page: null, data_refreshed_at: null }],
    [
      "an amount sent as a number",
      { data: [{ ...day(0), group: {}, cost: { currency: "USD", amount: 4 } }], has_more: false, next_page: null, data_refreshed_at: REFRESHED },
    ],
  ])("rejects %s as INVALID_RESPONSE", async (_label, body) => {
    const { fetchImpl } = recordingFetch(() => json(body));
    await expect(anthropicAdapter.listCosts(request(fetchImpl))).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it.each([
    ["an empty window", { end: new Date(START) }],
    ["a window not on UTC midnight", { start: new Date(START + 3_600_000) }],
    ["a window longer than 31 days", { end: new Date(START + 32 * DAY) }],
  ])("refuses %s before any request", async (_label, extra) => {
    const { calls, fetchImpl } = recordingFetch(healthyResponse);
    await expect(anthropicAdapter.listCosts(request(fetchImpl, extra))).rejects.toThrow(RangeError);
    expect(calls).toHaveLength(0);
  });
});

describe("anthropicAmount", () => {
  it.each([
    ["41280.000000", "412.8"],
    ["0.000001", "0.00000001"],
    ["-150.5", "-1.505"],
  ])("reads %s cents as %s", (cents, expected) => {
    expect(anthropicAmount(cents)).toBe(expected);
  });

  it("rejects an exponent or a number", () => {
    expect(() => anthropicAmount("1e3")).toThrow(ProviderError);
    expect(() => anthropicAmount(12)).toThrow(ProviderError);
  });
});

describe("listAnthropicOrganizationTotals", () => {
  it("sums the ungrouped organization total per currency", async () => {
    const { calls, fetchImpl } = recordingFetch(healthyResponse);
    const totals = await listAnthropicOrganizationTotals(request(fetchImpl));

    expect(calls.every((call) => call.url.searchParams.getAll("group_by[]").length === 0)).toBe(true);
    expect(totals.complete).toBe(true);
    expect(totals.totals.get("USD")?.toFixed()).toBe("0.15");
  });

  it("flags a total cut by the bound as incomplete", async () => {
    const { fetchImpl } = recordingFetch(healthyResponse);
    expect((await listAnthropicOrganizationTotals(request(fetchImpl, { maxPages: 1 }))).complete).toBe(false);
  });
});
