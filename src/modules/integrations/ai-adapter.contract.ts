import { describe, expect, it } from "vitest";
import { ProviderError } from "./adapter";
import {
  assertAiScope,
  assertCostRecord,
  assertUsageRecord,
  type AiPageOutcome,
  type AiPageRequest,
  type AiProviderAdapter,
} from "./ai-adapter";

/**
 * Shared contract suite (M11-01): every AI adapter's test file calls
 * `describeAiAdapterContract` with its own fixtures served by a fake `fetch`.
 * No scenario reaches the network and no scenario needs a real credential.
 */

export type AiContractHarness = {
  name: string;
  adapter: AiProviderAdapter;
  /** A fake credential: the suite checks it never leaks into errors or records. */
  token: string;
  /** `""` for the provider's public API; a self-hosted URL for `CUSTOM`. */
  instanceUrl: string;
  transports: {
    /** Auth and discovery succeed; usage and costs span at least two pages each. */
    healthy: () => typeof fetch;
    /** Every request answers HTTP 401. */
    revoked: () => typeof fetch;
    /** Every request answers HTTP 403. */
    forbidden: () => typeof fetch;
    /** Every request answers HTTP 429 with `Retry-After: 30`. */
    rateLimited: () => typeof fetch;
    /** The first usage/cost page succeeds, the next one answers 429 `Retry-After: 30`. */
    rateLimitedAfterFirstPage: () => typeof fetch;
    /** Every request answers 200 with a body that is not the expected shape. */
    malformed: () => typeof fetch;
  };
};

const RANGE = {
  start: new Date("2026-10-01T00:00:00Z"),
  end: new Date("2026-11-01T00:00:00Z"),
};

type Listing = "listUsage" | "listCosts";

export function describeAiAdapterContract(harness: AiContractHarness): void {
  const { adapter, token, instanceUrl, transports } = harness;

  const page = (fetchImpl: typeof fetch, extra: Partial<AiPageRequest> = {}): AiPageRequest => ({
    token,
    instanceUrl,
    fetchImpl,
    ...RANGE,
    cursor: null,
    ...extra,
  });

  async function caught(promise: Promise<unknown>): Promise<ProviderError> {
    const error = await promise.then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(ProviderError);
    const providerError = error as ProviderError;
    expect(providerError.message).not.toContain(token);
    expect(providerError.toSafeMessage()).not.toContain(token);
    return providerError;
  }

  async function readAll(listing: Listing, fetchImpl: typeof fetch) {
    const ids: string[] = [];
    let cursor: string | null = null;

    for (let run = 0; run < 50; run += 1) {
      const outcome: AiPageOutcome<{ externalId: string }> = await adapter[listing](
        page(fetchImpl, { cursor, maxPages: 1 }),
      );
      ids.push(...outcome.records.map((record) => record.externalId));
      cursor = outcome.nextCursor;
      if (cursor === null) return ids;
    }

    throw new Error("Pagination sans fin.");
  }

  describe(`contrat adaptateur IA : ${harness.name}`, () => {
    it("declares read-only scopes", () => {
      for (const scope of adapter.requiredScopes) {
        expect(scope).not.toMatch(/write|admin:write|delete/i);
      }
    });

    it("tests a valid credential without exposing it", async () => {
      const result = await adapter.testAuth({ token, instanceUrl, fetchImpl: transports.healthy() });
      expect(result.accountLabel.length).toBeGreaterThan(0);
      expect(JSON.stringify(result)).not.toContain(token);
    });

    it("reports a revoked credential as UNAUTHORIZED", async () => {
      const error = await caught(adapter.testAuth({ token, instanceUrl, fetchImpl: transports.revoked() }));
      expect(error.code).toBe("UNAUTHORIZED");
    });

    it("reports a missing permission as FORBIDDEN", async () => {
      const error = await caught(adapter.testAuth({ token, instanceUrl, fetchImpl: transports.forbidden() }));
      expect(error.code).toBe("FORBIDDEN");
    });

    it("discovers valid scopes", async () => {
      const discovery = await adapter.discover({ token, instanceUrl, fetchImpl: transports.healthy() });
      expect(discovery.scopes.length).toBeGreaterThan(0);
      discovery.scopes.forEach((scope) => assertAiScope(scope));
    });

    describe.each<Listing>(["listUsage", "listCosts"])("%s", (listing) => {
      const assertRecord = listing === "listUsage" ? assertUsageRecord : assertCostRecord;

      it("reads every page into valid, unique records", async () => {
        const outcome = await adapter[listing](page(transports.healthy()));
        expect(outcome.stoppedBy).toBeNull();
        expect(outcome.nextCursor).toBeNull();
        expect(outcome.pagesRead).toBeGreaterThanOrEqual(2);
        outcome.records.forEach((record) => assertRecord(record));
        const ids = outcome.records.map((record) => record.externalId);
        expect(new Set(ids).size).toBe(ids.length);
        expect(JSON.stringify(outcome)).not.toContain(token);
      });

      it("stops at maxPages with a cursor that resumes without gap or duplicate", async () => {
        const fetchImpl = transports.healthy();
        const full = await adapter[listing](page(fetchImpl));

        const first = await adapter[listing](page(fetchImpl, { maxPages: 1 }));
        expect(first.stoppedBy).toBe("MAX_PAGES");
        expect(first.nextCursor).not.toBeNull();
        expect(first.nextCursor).not.toContain(token);

        const resumed = await readAll(listing, fetchImpl);
        expect(resumed).toEqual(full.records.map((record) => record.externalId));
      });

      it("is re-runnable: the same cursor returns the same records", async () => {
        const fetchImpl = transports.healthy();
        const once = await adapter[listing](page(fetchImpl));
        const twice = await adapter[listing](page(fetchImpl));
        expect(twice.records.map((r) => r.externalId)).toEqual(
          once.records.map((r) => r.externalId),
        );
      });

      it("throws UNAUTHORIZED on a revoked credential", async () => {
        const error = await caught(adapter[listing](page(transports.revoked())));
        expect(error.code).toBe("UNAUTHORIZED");
      });

      it("throws RATE_LIMITED with the stated wait when the first page is refused", async () => {
        const error = await caught(adapter[listing](page(transports.rateLimited())));
        expect(error.code).toBe("RATE_LIMITED");
        expect(error.details.retryAfterSeconds).toBe(30);
      });

      it("returns a resumable partial outcome when a later page is rate limited", async () => {
        const outcome = await adapter[listing](page(transports.rateLimitedAfterFirstPage()));
        expect(outcome.stoppedBy).toBe("RATE_LIMITED");
        expect(outcome.retryAfterSeconds).toBe(30);
        expect(outcome.pagesRead).toBe(1);
        expect(outcome.records.length).toBeGreaterThan(0);
        expect(outcome.nextCursor).not.toBeNull();

        const rest = await adapter[listing](
          page(transports.healthy(), { cursor: outcome.nextCursor }),
        );
        const full = await adapter[listing](page(transports.healthy()));
        expect([...outcome.records, ...rest.records].map((r) => r.externalId)).toEqual(
          full.records.map((r) => r.externalId),
        );
      });

      it("throws INVALID_RESPONSE on a malformed payload", async () => {
        const error = await caught(adapter[listing](page(transports.malformed())));
        expect(error.code).toBe("INVALID_RESPONSE");
      });
    });
  });
}
