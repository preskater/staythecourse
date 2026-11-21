import { describe, expect, it } from "vitest";
import { ProviderError } from "./adapter";
import type { AiPageRequest } from "./ai-adapter";
import { describeAiAdapterContract } from "./ai-adapter.contract";
import {
  listOpenAiOrganizationTotals,
  openAiAdapter,
  openAiAmount,
  OPENAI_COST_GROUP_BY,
} from "./openai";

/**
 * OpenAI responses are simulated from the shapes of the public API reference
 * (`GET /organization/costs`, `GET /organization/projects`). No test reaches OpenAI
 * and the key below is fictitious.
 */

const TOKEN = "fake-openai-admin-key";
const DAY = 86_400;
const START = Date.UTC(2026, 9, 1) / 1000;

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

const PAGES = 3;

function groupedResults() {
  return [
    {
      object: "organization.costs.result",
      amount: { value: 0.06, currency: "usd" },
      project_id: "proj_1",
      api_key_id: "key_1",
      line_item: "gpt-x, input",
      api_source: null,
    },
    {
      object: "organization.costs.result",
      // Unattributed and a credit: no project, no key, negative amount.
      amount: { value: -0.01, currency: "usd" },
      project_id: null,
      api_key_id: null,
      line_item: "credit",
      api_source: null,
    },
  ];
}

function costsResponse(url: URL): Response {
  const index = pageIndex(url);
  const grouped = url.searchParams.getAll("group_by").length > 0;
  const start = START + index * DAY;

  return json({
    object: "page",
    data: [
      {
        object: "bucket",
        start_time: start,
        end_time: start + DAY,
        results: grouped
          ? groupedResults()
          : [{ object: "organization.costs.result", amount: { value: 0.05, currency: "usd" } }],
      },
    ],
    has_more: index < PAGES - 1,
    next_page: index < PAGES - 1 ? `page_${index + 2}` : null,
  });
}

function healthyResponse(url: URL): Response {
  switch (url.pathname) {
    case "/v1/organization/projects":
      return json({
        object: "list",
        data: [{ id: "proj_1", object: "organization.project", name: "Projet 1" }],
        has_more: false,
        last_id: "proj_1",
      });
    case "/v1/organization/costs":
      return costsResponse(url);
    default:
      return json({ error: "not found" }, 404);
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

describeAiAdapterContract({
  name: "openai",
  adapter: openAiAdapter,
  token: TOKEN,
  instanceUrl: "",
  transports: {
    healthy: transport(healthyResponse),
    revoked: transport(() => json({ error: { message: "Incorrect API key" } }, 401)),
    forbidden: transport(() => json({ error: { message: "Missing scope" } }, 403)),
    rateLimited: transport(() => json({}, 429, { "retry-after": "30" })),
    rateLimitedAfterFirstPage: transport((url) =>
      pageIndex(url) > 0 ? json({}, 429, { "retry-after": "30" }) : healthyResponse(url),
    ),
    malformed: transport(() => json({ unexpected: true })),
  },
});

const request = (fetchImpl: typeof fetch, extra: Partial<AiPageRequest> = {}): AiPageRequest => ({
  token: TOKEN,
  instanceUrl: "",
  fetchImpl,
  start: new Date(START * 1000),
  end: new Date((START + PAGES * DAY) * 1000),
  cursor: null,
  ...extra,
});

describe("openAiAdapter.listCosts", () => {
  it("normalises a page: exact amount, uppercase currency, known dimensions only", async () => {
    const { fetchImpl } = recordingFetch(healthyResponse);
    const outcome = await openAiAdapter.listCosts(request(fetchImpl, { maxPages: 1 }));

    expect(outcome.records).toEqual([
      {
        externalId: `${START}|proj_1|key_1|gpt-x, input|`,
        scopeId: "proj_1",
        model: null,
        periodStart: new Date(START * 1000),
        periodEnd: new Date((START + DAY) * 1000),
        amount: "0.06",
        currency: "USD",
        dimensions: { apiKeyId: "key_1", lineItem: "gpt-x, input" },
      },
      {
        externalId: `${START}|||credit|`,
        // Unknown, not estimated: no project, no key, no source.
        scopeId: null,
        model: null,
        periodStart: new Date(START * 1000),
        periodEnd: new Date((START + DAY) * 1000),
        amount: "-0.01",
        currency: "USD",
        dimensions: { lineItem: "credit" },
      },
    ]);
  });

  it("asks for the window in Unix seconds, daily buckets and the documented grouping", async () => {
    const { calls, fetchImpl } = recordingFetch(healthyResponse);
    await openAiAdapter.listCosts(request(fetchImpl, { maxPages: 1 }));

    const { url, headers } = calls[0];
    expect(url.origin + url.pathname).toBe("https://api.openai.com/v1/organization/costs");
    expect(url.searchParams.get("start_time")).toBe(String(START));
    expect(url.searchParams.get("end_time")).toBe(String(START + PAGES * DAY));
    expect(url.searchParams.get("bucket_width")).toBe("1d");
    expect(url.searchParams.getAll("group_by")).toEqual([...OPENAI_COST_GROUP_BY]);
    // user_id + project_id may be refused by OpenAI: the user dimension stays unknown.
    expect(url.searchParams.getAll("group_by")).not.toContain("user_id");
    // The key travels in a header, never in the URL.
    expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(url.toString()).not.toContain(TOKEN);
  });

  it("returns a complete, empty outcome for a window without spend", async () => {
    const { fetchImpl } = recordingFetch(() =>
      json({
        object: "page",
        data: [{ object: "bucket", start_time: START, end_time: START + DAY, results: [] }],
        has_more: false,
        next_page: null,
      }),
    );
    const outcome = await openAiAdapter.listCosts(request(fetchImpl));
    expect(outcome).toMatchObject({ records: [], stoppedBy: null, nextCursor: null, pagesRead: 1 });
  });

  it("gives the same external ids on a re-run, so an upsert creates nothing new", async () => {
    const ids = async () =>
      (await openAiAdapter.listCosts(request(recordingFetch(healthyResponse).fetchImpl))).records.map(
        (record) => record.externalId,
      );
    expect(await ids()).toEqual(await ids());
  });

  it.each([
    ["has_more without a cursor", { object: "page", data: [], has_more: true, next_page: null }],
    ["a bucket without results", { object: "page", data: [{ start_time: START, end_time: START + DAY }], has_more: false, next_page: null }],
    [
      "an amount sent as text",
      {
        object: "page",
        data: [{ start_time: START, end_time: START + DAY, results: [{ amount: { value: "0.06", currency: "usd" } }] }],
        has_more: false,
        next_page: null,
      },
    ],
  ])("rejects %s as INVALID_RESPONSE", async (_label, body) => {
    const { fetchImpl } = recordingFetch(() => json(body));
    await expect(openAiAdapter.listCosts(request(fetchImpl))).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });

  it("refuses an empty or reversed window before any request", async () => {
    const { calls, fetchImpl } = recordingFetch(healthyResponse);
    const at = new Date(START * 1000);
    await expect(openAiAdapter.listCosts(request(fetchImpl, { start: at, end: at }))).rejects.toThrow(
      RangeError,
    );
    expect(calls).toHaveLength(0);
  });
});

describe("openAiAmount", () => {
  it.each([
    [0.06, "0.06"],
    [0.1 + 0.2, "0.30000000000000004"],
    [1e-7, "0.0000001"],
    [-12.5, "-12.5"],
  ])("reads %d as the exact decimal %s", (value, expected) => {
    expect(openAiAmount(value)).toBe(expected);
  });

  it("rejects a non-finite amount", () => {
    expect(() => openAiAmount(Number.NaN)).toThrow(ProviderError);
  });
});

describe("listOpenAiOrganizationTotals", () => {
  it("sums the ungrouped organization total per currency", async () => {
    const { calls, fetchImpl } = recordingFetch(healthyResponse);
    const totals = await listOpenAiOrganizationTotals(request(fetchImpl));

    expect(calls.every((call) => call.url.searchParams.getAll("group_by").length === 0)).toBe(true);
    expect(totals.complete).toBe(true);
    expect(totals.totals.get("USD")?.toFixed()).toBe("0.15");
  });

  it("flags a total cut by the bound as incomplete", async () => {
    const { fetchImpl } = recordingFetch(healthyResponse);
    expect((await listOpenAiOrganizationTotals(request(fetchImpl, { maxPages: 1 }))).complete).toBe(false);
  });
});

describe("openAiAdapter.testAuth", () => {
  it("accepts a working admin key without echoing it", async () => {
    const { fetchImpl } = recordingFetch(healthyResponse);
    const result = await openAiAdapter.testAuth({ token: TOKEN, instanceUrl: "", fetchImpl });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });
});
