import { describe, expect, it } from "vitest";
import { ProviderError, requestJson } from "./adapter";
import {
  assertAiScope,
  assertCostRecord,
  assertUsageRecord,
  classifyAiResponse,
  collectAiPages,
  resolveAiBaseUrl,
  type AiCostRecord,
  type AiPageRequest,
  type AiProvider,
  type AiProviderAdapter,
  type AiRequest,
  type AiUsageRecord,
} from "./ai-adapter";
import { describeAiAdapterContract } from "./ai-adapter.contract";
import { createRetryingFetch } from "./retry";

/**
 * A fake provider proves the contract is satisfiable and exercises the shared
 * pagination rules. It speaks HTTP to a fictitious host through an injected fetch.
 */

const BASE = "https://ai.fake.test/v1";
const TOKEN = "fake-ai-key-000";

type FakeList<T> = { data: T[]; next: string | null };

function fakeAdapter(provider: AiProvider = "OPENAI", publicBase: string | null = BASE): AiProviderAdapter {
  const get = <T>(request: AiRequest, path: string) =>
    requestJson<T>({
      url: `${resolveAiBaseUrl(request.instanceUrl, publicBase)}${path}`,
      headers: { authorization: `Bearer ${request.token}` },
      fetchImpl: request.fetchImpl ?? fetch,
      signal: request.signal,
      classifyError: (response) => classifyAiResponse(response, "Fake"),
    }).then(({ data }) => data);

  const listOf = <T>(data: unknown): FakeList<T> => {
    const list = data as Partial<FakeList<T>>;
    if (!Array.isArray(list?.data) || !(list.next === null || typeof list.next === "string")) {
      throw new ProviderError("INVALID_RESPONSE", "Liste Fake illisible.");
    }
    return list as FakeList<T>;
  };

  const paged = <Raw, T>(
    request: AiPageRequest,
    path: string,
    normalise: (raw: Raw) => T,
    assert: (record: T) => void,
  ) =>
    collectAiPages(request, async (cursor) => {
      const query = cursor ? `?after=${encodeURIComponent(cursor)}` : "";
      const list = listOf<Raw>(await get(request, `${path}${query}`));
      const records = list.data.map(normalise);
      records.forEach(assert);
      return { records, nextCursor: list.next };
    });

  type RawRow = Record<string, unknown>;
  const scope = (row: RawRow) => (typeof row.project === "string" ? row.project : null);

  return {
    provider,
    requiredScopes: ["usage:read"],
    async testAuth(request) {
      const me = (await get<{ name?: unknown }>(request, "/me")) ?? {};
      if (typeof me.name !== "string") {
        throw new ProviderError("INVALID_RESPONSE", "Compte Fake illisible.");
      }
      return { accountLabel: me.name, grantedScopes: ["usage:read"] };
    },
    async discover(request) {
      const list = listOf<RawRow>(await get(request, "/projects"));
      const scopes = list.data.map((row) => ({
        externalId: row.id as string,
        name: row.name as string,
        kind: "project" as const,
      }));
      scopes.forEach(assertAiScope);
      return { scopes, fetchedAt: new Date() };
    },
    listUsage: (request) =>
      paged<RawRow, AiUsageRecord>(
        request,
        "/usage",
        (row) => ({
          externalId: row.id as string,
          scopeId: scope(row),
          model: row.model as string,
          periodStart: new Date(row.start as string),
          periodEnd: new Date(row.end as string),
          inputTokens: row.input as number,
          outputTokens: row.output as number,
          requests: (row.requests as number | undefined) ?? null,
        }),
        assertUsageRecord,
      ),
    listCosts: (request) =>
      paged<RawRow, AiCostRecord>(
        request,
        "/costs",
        (row) => ({
          externalId: row.id as string,
          scopeId: scope(row),
          model: (row.model as string | undefined) ?? null,
          periodStart: new Date(row.start as string),
          periodEnd: new Date(row.end as string),
          amount: row.amount as string,
          currency: row.currency as string,
          dimensions: {},
        }),
        assertCostRecord,
      ),
  };
}

// Three pages per listing: cursors "p2" and "p3".
function usagePage(index: number) {
  return [0, 1].map((n) => ({
    id: `u-${index}-${n}`,
    project: "proj-1",
    model: "fake-model",
    start: `2026-10-0${index + 1}T00:00:00Z`,
    end: `2026-10-0${index + 2}T00:00:00Z`,
    input: 100 * (n + 1),
    output: 50,
    requests: 3,
  }));
}

function costPage(index: number) {
  return [0, 1].map((n) => ({
    id: `c-${index}-${n}`,
    project: "proj-1",
    start: `2026-10-0${index + 1}T00:00:00Z`,
    end: `2026-10-0${index + 2}T00:00:00Z`,
    amount: n === 0 ? "1.2345" : "-0.10",
    currency: "USD",
  }));
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

function pageIndex(url: URL): number {
  const after = url.searchParams.get("after");
  return after ? Number(after.slice(1)) - 1 : 0;
}

function healthyResponse(url: URL): Response {
  const index = pageIndex(url);
  const next = index < 2 ? `p${index + 2}` : null;

  switch (url.pathname) {
    case "/v1/me":
      return json({ name: "Fake org" });
    case "/v1/projects":
      return json({ data: [{ id: "proj-1", name: "Projet 1" }], next: null });
    case "/v1/usage":
      return json({ data: usagePage(index), next });
    case "/v1/costs":
      return json({ data: costPage(index), next });
    default:
      return json({}, 404);
  }
}

const transport =
  (handler: (url: URL) => Response): (() => typeof fetch) =>
  () =>
    (async (input: RequestInfo | URL) => handler(new URL(String(input)))) as typeof fetch;

const fakeTransports = {
  healthy: transport(healthyResponse),
  revoked: transport(() => json({ error: "invalid key" }, 401)),
  forbidden: transport(() => json({ error: "missing scope" }, 403)),
  rateLimited: transport(() => json({}, 429, { "retry-after": "30" })),
  rateLimitedAfterFirstPage: transport((url) =>
    pageIndex(url) > 0 ? json({}, 429, { "retry-after": "30" }) : healthyResponse(url),
  ),
  malformed: transport(() => json({ unexpected: true })),
};

describeAiAdapterContract({
  name: "fake",
  adapter: fakeAdapter(),
  token: TOKEN,
  instanceUrl: "",
  transports: fakeTransports,
});

// A self-hosted provider passes the same suite through its own base URL.
describeAiAdapterContract({
  name: "fake self-hosted (CUSTOM)",
  adapter: fakeAdapter("CUSTOM", null),
  token: TOKEN,
  instanceUrl: "https://llm.internal.test/v1/",
  transports: {
    ...fakeTransports,
    healthy: transport((url) =>
      url.host === "llm.internal.test" ? healthyResponse(url) : json({}, 404),
    ),
  },
});

describe("resolveAiBaseUrl", () => {
  it("falls back to the public API when no instance is configured", () => {
    expect(resolveAiBaseUrl("  ", BASE)).toBe(BASE);
  });

  it("uses the configured instance without its trailing slash", () => {
    expect(resolveAiBaseUrl("https://llm.internal.test/v1/", BASE)).toBe(
      "https://llm.internal.test/v1",
    );
  });

  it.each([
    ["no URL for a provider without public API", "", null],
    ["an unparsable URL", "not a url", null],
    ["a non-HTTP scheme", "ftp://llm.internal.test", null],
    ["credentials in the URL", "https://user:secret@llm.internal.test", null],
  ])("rejects %s", (_label, instanceUrl, publicBase) => {
    expect(() => resolveAiBaseUrl(instanceUrl, publicBase)).toThrow(ProviderError);
  });
});

describe("collectAiPages", () => {
  const pages = (count: number) => async (cursor: string | null) => {
    const index = cursor ? Number(cursor) : 0;
    return { records: [index], nextCursor: index + 1 < count ? String(index + 1) : null };
  };

  it("rejects a non-positive bound", async () => {
    await expect(collectAiPages({ cursor: null, maxPages: 0 }, pages(1))).rejects.toThrow(
      RangeError,
    );
  });

  it("fails on a repeated cursor instead of looping to the bound", async () => {
    const error = await collectAiPages({ cursor: null }, async () => ({
      records: [],
      nextCursor: "same",
    })).catch((reason: unknown) => reason);
    // First page moves null → "same", second repeats "same".
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).code).toBe("INVALID_RESPONSE");
  });

  it("returns partial on a network error after the first page, resuming at the failed page", async () => {
    const outcome = await collectAiPages({ cursor: null }, async (cursor) => {
      if (cursor === "1") throw new ProviderError("NETWORK", "coupure");
      return { records: [cursor], nextCursor: "1" };
    });
    expect(outcome).toMatchObject({ stoppedBy: "NETWORK", nextCursor: "1", pagesRead: 1 });
  });

  it("throws UNAUTHORIZED even after pages were read", async () => {
    let calls = 0;
    const promise = collectAiPages({ cursor: null }, async () => {
      calls += 1;
      if (calls === 2) throw new ProviderError("UNAUTHORIZED", "révoquée");
      return { records: [calls], nextCursor: String(calls) };
    });
    await expect(promise).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

describe("classifyAiResponse", () => {
  it.each([
    [401, "UNAUTHORIZED"],
    [403, "FORBIDDEN"],
    [404, "NOT_FOUND"],
    [429, "RATE_LIMITED"],
    [500, "HTTP_ERROR"],
  ])("maps HTTP %i to %s", (status, code) => {
    expect(classifyAiResponse(new Response(null, { status }), "Fake").code).toBe(code);
  });
});

describe("record validation", () => {
  const usage: AiUsageRecord = {
    externalId: "u",
    scopeId: null,
    model: "m",
    periodStart: new Date("2026-10-01T00:00:00Z"),
    periodEnd: new Date("2026-10-02T00:00:00Z"),
    inputTokens: 1,
    outputTokens: 0,
    requests: null,
  };
  const cost: AiCostRecord = {
    externalId: "c",
    scopeId: null,
    model: null,
    periodStart: usage.periodStart,
    periodEnd: usage.periodEnd,
    amount: "-0.50",
    currency: "EUR",
    dimensions: {},
  };

  it("accepts credits and unknown request counts", () => {
    expect(() => assertUsageRecord(usage)).not.toThrow();
    expect(() => assertCostRecord(cost)).not.toThrow();
  });

  it.each([
    ["float-formatted exponent", { amount: "1e3" }],
    ["missing amount", { amount: undefined }],
    ["lowercase currency", { currency: "eur" }],
    ["empty period", { periodEnd: usage.periodStart }],
  ])("rejects a cost with %s", (_label, patch) => {
    expect(() => assertCostRecord({ ...cost, ...patch })).toThrow(ProviderError);
  });

  it("rejects negative or fractional token counts", () => {
    expect(() => assertUsageRecord({ ...usage, inputTokens: -1 })).toThrow(ProviderError);
    expect(() => assertUsageRecord({ ...usage, outputTokens: 1.5 })).toThrow(ProviderError);
  });
});

describe("retry convention", () => {
  it("a transient 503 is absorbed by the shared retrying fetch, not by the adapter", async () => {
    let calls = 0;
    const flaky = (async (input: RequestInfo | URL) => {
      calls += 1;
      return calls === 1 ? json({}, 503) : healthyResponse(new URL(String(input)));
    }) as typeof fetch;
    const retrying = createRetryingFetch({ fetchImpl: flaky, sleep: async () => {} });

    const outcome = await fakeAdapter().listUsage!({
      token: TOKEN,
      instanceUrl: "",
      fetchImpl: retrying.fetchImpl,
      start: new Date("2026-10-01T00:00:00Z"),
      end: new Date("2026-11-01T00:00:00Z"),
      cursor: null,
    });

    expect(outcome.stoppedBy).toBeNull();
    expect(retrying.retries()).toBe(1);
  });
});
