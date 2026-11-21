import { describe, expect, it } from "vitest";
import { ProviderError } from "./adapter";
import {
  assertBillingCustomer,
  assertBillingInvoice,
  assertBillingPayment,
  assertBillingRefund,
  BILLING_ADAPTER_MEMBERS,
  billingSourceKey,
  type BillingPageOutcome,
  type BillingPageRequest,
  type BillingProviderAdapter,
  type BillingSource,
} from "./billing-adapter";

/**
 * Shared contract suite (M16-01): every billing adapter's test file calls
 * `describeBillingAdapterContract` with its own fixtures served by a fake `fetch`.
 * No scenario reaches the network and none needs a real key.
 */

export type BillingContractHarness = {
  name: string;
  adapter: BillingProviderAdapter;
  /** A fake key: the suite checks it never leaks into errors, records or cursors. */
  token: string;
  instanceUrl: string;
  transports: {
    /** Auth succeeds; every listing spans at least two pages. */
    healthy: () => typeof fetch;
    /** Every request answers HTTP 401. */
    revoked: () => typeof fetch;
    /** Every request answers HTTP 403. */
    forbidden: () => typeof fetch;
    /** Every request answers HTTP 429 with `Retry-After: 30`. */
    rateLimited: () => typeof fetch;
    /** The first page of a listing succeeds, the next one answers 429 `Retry-After: 30`. */
    rateLimitedAfterFirstPage: () => typeof fetch;
    /** Every request answers 200 with a body that is not the expected shape. */
    malformed: () => typeof fetch;
  };
};

const RANGE = {
  start: new Date("2026-10-01T00:00:00Z"),
  end: new Date("2026-11-01T00:00:00Z"),
};

const LISTINGS = {
  listCustomers: assertBillingCustomer,
  listInvoices: assertBillingInvoice,
  listPayments: assertBillingPayment,
  listRefunds: assertBillingRefund,
} as const;
type Listing = keyof typeof LISTINGS;
type Sourced = { source: BillingSource };

/** Wraps a transport so the suite sees every HTTP method the adapter used. */
function recording(fetchImpl: typeof fetch, methods: string[]): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    methods.push((init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase());
    return fetchImpl(input, init);
  }) as typeof fetch;
}

function memberNames(adapter: object): string[] {
  const names = new Set(Object.keys(adapter));
  let proto = Object.getPrototypeOf(adapter);
  while (proto && proto !== Object.prototype) {
    Object.getOwnPropertyNames(proto).forEach((name) => name !== "constructor" && names.add(name));
    proto = Object.getPrototypeOf(proto);
  }
  return [...names];
}

export function describeBillingAdapterContract(harness: BillingContractHarness): void {
  const { adapter, token, instanceUrl, transports } = harness;
  const methods: string[] = [];

  const list = (listing: Listing, request: BillingPageRequest) =>
    adapter[listing](request) as Promise<BillingPageOutcome<Sourced>>;

  const page = (fetchImpl: typeof fetch, extra: Partial<BillingPageRequest> = {}): BillingPageRequest => ({
    token,
    instanceUrl,
    fetchImpl: recording(fetchImpl, methods),
    ...RANGE,
    cursor: null,
    ...extra,
  });

  const keys = (records: Sourced[]) => records.map((record) => billingSourceKey(record.source));

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
      const outcome: BillingPageOutcome<Sourced> = await list(listing, page(fetchImpl, { cursor, maxPages: 1 }));
      ids.push(...keys(outcome.records));
      cursor = outcome.nextCursor;
      if (cursor === null) return ids;
    }

    throw new Error("Pagination sans fin.");
  }

  describe(`contrat adaptateur de facturation : ${harness.name}`, () => {
    it("exposes reads only: no member outside the contract", () => {
      expect(memberNames(adapter).sort()).toEqual([...BILLING_ADAPTER_MEMBERS].sort());
    });

    it("declares read-only scopes", () => {
      expect(adapter.requiredScopes.length).toBeGreaterThan(0);
      for (const scope of adapter.requiredScopes) {
        expect(scope).toMatch(/read/i);
        expect(scope).not.toMatch(/write/i);
      }
    });

    it("tests a valid key without exposing it", async () => {
      const result = await adapter.testAuth({ token, instanceUrl, fetchImpl: transports.healthy() });
      expect(result.accountLabel.length).toBeGreaterThan(0);
      expect(typeof result.live).toBe("boolean");
      expect(JSON.stringify(result)).not.toContain(token);
    });

    it("reports a revoked key as UNAUTHORIZED", async () => {
      const error = await caught(adapter.testAuth({ token, instanceUrl, fetchImpl: transports.revoked() }));
      expect(error.code).toBe("UNAUTHORIZED");
    });

    it("reports a missing permission as FORBIDDEN", async () => {
      const error = await caught(adapter.testAuth({ token, instanceUrl, fetchImpl: transports.forbidden() }));
      expect(error.code).toBe("FORBIDDEN");
    });

    describe.each(Object.keys(LISTINGS) as Listing[])("%s", (listing) => {
      const assertRecord = LISTINGS[listing] as (record: Sourced) => void;

      it("reads every page into valid records with unique, preserved sources", async () => {
        const outcome = await list(listing, page(transports.healthy()));
        expect(outcome.stoppedBy).toBeNull();
        expect(outcome.nextCursor).toBeNull();
        expect(outcome.pagesRead).toBeGreaterThanOrEqual(2);
        expect(outcome.records.length).toBeGreaterThan(0);
        outcome.records.forEach(assertRecord);
        outcome.records.forEach((record) => {
          expect(record.source.provider).toBe(adapter.provider);
          expect(record.source.instanceUrl).toBe(instanceUrl);
        });
        expect(new Set(keys(outcome.records)).size).toBe(outcome.records.length);
        expect(JSON.stringify(outcome)).not.toContain(token);
      });

      it("stops at maxPages with a cursor that resumes without gap or duplicate", async () => {
        const full = await list(listing, page(transports.healthy()));

        const first = await list(listing, page(transports.healthy(), { maxPages: 1 }));
        expect(first.stoppedBy).toBe("MAX_PAGES");
        expect(first.nextCursor).not.toBeNull();
        expect(first.nextCursor).not.toContain(token);

        expect(await readAll(listing, transports.healthy())).toEqual(keys(full.records));
      });

      it("is idempotent: re-running returns the same sources", async () => {
        const once = await list(listing, page(transports.healthy()));
        const twice = await list(listing, page(transports.healthy()));
        expect(keys(twice.records)).toEqual(keys(once.records));
      });

      it("throws UNAUTHORIZED on a revoked key", async () => {
        expect((await caught(list(listing, page(transports.revoked())))).code).toBe("UNAUTHORIZED");
      });

      it("throws FORBIDDEN when the key cannot read this resource", async () => {
        expect((await caught(list(listing, page(transports.forbidden())))).code).toBe("FORBIDDEN");
      });

      it("throws RATE_LIMITED with the stated wait when the first page is refused", async () => {
        const error = await caught(list(listing, page(transports.rateLimited())));
        expect(error.code).toBe("RATE_LIMITED");
        expect(error.details.retryAfterSeconds).toBe(30);
      });

      it("returns a resumable partial outcome when a later page is rate limited", async () => {
        const outcome = await list(listing, page(transports.rateLimitedAfterFirstPage()));
        expect(outcome.stoppedBy).toBe("RATE_LIMITED");
        expect(outcome.retryAfterSeconds).toBe(30);
        expect(outcome.pagesRead).toBe(1);
        expect(outcome.nextCursor).not.toBeNull();

        const rest = await list(listing, page(transports.healthy(), { cursor: outcome.nextCursor }));
        const full = await list(listing, page(transports.healthy()));
        expect([...keys(outcome.records), ...keys(rest.records)]).toEqual(keys(full.records));
      });

      it("throws INVALID_RESPONSE on a malformed payload", async () => {
        expect((await caught(list(listing, page(transports.malformed())))).code).toBe("INVALID_RESPONSE");
      });
    });

    it("never sent anything but GET", () => {
      expect(methods.length).toBeGreaterThan(0);
      expect(new Set(methods)).toEqual(new Set(["GET"]));
    });
  });
}
