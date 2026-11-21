import { describe, expect, it } from "vitest";
import { ProviderError, requestJson } from "./adapter";
import {
  assertBillingCustomer,
  assertBillingInvoice,
  assertBillingPayment,
  assertBillingRefund,
  BILLING_ADAPTER_MEMBERS,
  billingSourceKey,
  classifyBillingResponse,
  collectBillingPages,
  type BillingInvoice,
  type BillingPageRequest,
  type BillingProviderAdapter,
  type BillingRequest,
  type BillingSource,
} from "./billing-adapter";
import { describeBillingAdapterContract } from "./billing-adapter.contract";

/**
 * A fake billing provider proves the contract is satisfiable. It speaks HTTP to a
 * fictitious host through an injected fetch; all data is invented.
 */

const BASE = "https://billing.fake.test/v1";
const TOKEN = "rk_fake_000";

type Raw = Record<string, unknown>;
type FakeList = { data: Raw[]; next: string | null };

function fakeAdapter(instanceUrl = ""): BillingProviderAdapter {
  const base = instanceUrl || BASE;

  const get = <T>(request: BillingRequest, path: string) =>
    requestJson<T>({
      url: `${base}${path}`,
      headers: { authorization: `Bearer ${request.token}` },
      fetchImpl: request.fetchImpl ?? fetch,
      signal: request.signal,
      classifyError: (response) => classifyBillingResponse(response, "Fake"),
    }).then(({ data }) => data);

  const source = (id: unknown): BillingSource => ({
    provider: "STRIPE",
    instanceUrl,
    externalId: id as string,
    url: `https://dashboard.fake.test/${id as string}`,
  });
  const at = (value: unknown) => (typeof value === "number" ? new Date(value * 1000) : null);
  const cents = (value: unknown) => (typeof value === "number" ? (value / 100).toFixed(2) : undefined);

  function paged<T>(request: BillingPageRequest, path: string, normalise: (raw: Raw) => T, assert: (record: T) => void) {
    return collectBillingPages(request, async (cursor) => {
      const query = cursor ? `?after=${encodeURIComponent(cursor)}` : "";
      const list = (await get<Partial<FakeList>>(request, `${path}${query}`)) ?? {};
      if (!Array.isArray(list.data) || !(list.next === null || typeof list.next === "string")) {
        throw new ProviderError("INVALID_RESPONSE", "Liste Fake illisible.");
      }
      const records = list.data.map(normalise);
      records.forEach(assert);
      return { records, nextCursor: list.next };
    });
  }

  return {
    provider: "STRIPE",
    requiredScopes: ["customers:read", "invoices:read", "charges:read", "refunds:read"],
    async testAuth(request) {
      const account = (await get<Raw>(request, "/account")) ?? {};
      if (typeof account.name !== "string") throw new ProviderError("INVALID_RESPONSE", "Compte Fake illisible.");
      return { accountLabel: account.name, grantedScopes: null, live: account.live === true };
    },
    listCustomers: (request) =>
      paged(request, "/customers", (raw) => ({ source: source(raw.id), name: (raw.name as string) ?? null, createdAt: at(raw.created)! }), assertBillingCustomer),
    listInvoices: (request) =>
      paged(
        request,
        "/invoices",
        (raw): BillingInvoice => ({
          source: source(raw.id),
          kind: raw.credit_for ? "CREDIT_NOTE" : "INVOICE",
          creditNoteForId: (raw.credit_for as string) ?? null,
          customerId: (raw.customer as string) ?? null,
          number: (raw.number as string) ?? null,
          status: String(raw.status).toUpperCase() as BillingInvoice["status"],
          currency: String(raw.currency).toUpperCase(),
          total: cents(raw.total)!,
          tax: cents(raw.tax) ?? null,
          amountPaid: cents(raw.amount_paid)!,
          amountDue: cents(raw.amount_due)!,
          issuedAt: at(raw.finalized_at),
          dueAt: at(raw.due_date),
          lines: (raw.lines as Raw[]).map((line) => ({
            externalId: line.id as string,
            description: (line.description as string) ?? null,
            quantity: line.quantity === undefined ? null : String(line.quantity),
            amount: cents(line.amount)!,
            periodStart: null,
            periodEnd: null,
          })),
        }),
        assertBillingInvoice,
      ),
    listPayments: (request) =>
      paged(
        request,
        "/payments",
        (raw) => ({
          source: source(raw.id),
          invoiceId: (raw.invoice as string) ?? null,
          customerId: (raw.customer as string) ?? null,
          status: String(raw.status).toUpperCase() as "SUCCEEDED",
          amount: cents(raw.amount)!,
          currency: String(raw.currency).toUpperCase(),
          createdAt: at(raw.created)!,
        }),
        assertBillingPayment,
      ),
    listRefunds: (request) =>
      paged(
        request,
        "/refunds",
        (raw) => ({
          source: source(raw.id),
          paymentId: raw.payment as string,
          invoiceId: (raw.invoice as string) ?? null,
          status: String(raw.status).toUpperCase() as "SUCCEEDED",
          amount: cents(raw.amount)!,
          currency: String(raw.currency).toUpperCase(),
          createdAt: at(raw.created)!,
        }),
        assertBillingRefund,
      ),
  };
}

// Three pages per listing, two records each; cursors "p2" and "p3".
const CREATED = 1_791_000_000;
const ROWS: Record<string, (id: string) => Raw> = {
  "/v1/customers": (id) => ({ id, name: `Client ${id}`, created: CREATED }),
  "/v1/invoices": (id) => ({
    id,
    customer: "cus_1",
    number: `F-${id}`,
    status: "paid",
    currency: "eur",
    total: 120050,
    tax: 20008,
    amount_paid: 120050,
    amount_due: 0,
    finalized_at: CREATED,
    due_date: CREATED + 2_592_000,
    lines: [{ id: `${id}-l1`, description: "Développement", quantity: 3, amount: 120050 }],
  }),
  "/v1/payments": (id) => ({ id, invoice: "in_1", customer: "cus_1", status: "succeeded", amount: 120050, currency: "eur", created: CREATED }),
  "/v1/refunds": (id) => ({ id, payment: "py_1", invoice: "in_1", status: "succeeded", amount: 5000, currency: "eur", created: CREATED }),
};

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function pageIndex(url: URL): number {
  const after = url.searchParams.get("after");
  return after ? Number(after.slice(1)) - 1 : 0;
}

function healthyResponse(url: URL): Response {
  if (url.pathname === "/v1/account") return json({ name: "Studio fictif", live: false });

  const row = ROWS[url.pathname];
  if (!row) return json({}, 404);

  const index = pageIndex(url);
  const prefix = url.pathname.split("/").pop()!.slice(0, 3);
  return json({ data: [0, 1].map((n) => row(`${prefix}_${index}_${n}`)), next: index < 2 ? `p${index + 2}` : null });
}

const transport =
  (handler: (url: URL) => Response): (() => typeof fetch) =>
  () =>
    (async (input: RequestInfo | URL) => handler(new URL(String(input)))) as typeof fetch;

const fakeTransports = {
  healthy: transport(healthyResponse),
  revoked: transport(() => json({ error: "invalid key" }, 401)),
  forbidden: transport(() => json({ error: "restricted key" }, 403)),
  rateLimited: transport(() => json({}, 429, { "retry-after": "30" })),
  rateLimitedAfterFirstPage: transport((url) =>
    pageIndex(url) > 0 ? json({}, 429, { "retry-after": "30" }) : healthyResponse(url),
  ),
  malformed: transport(() => json({ unexpected: true })),
};

describeBillingAdapterContract({
  name: "fake",
  adapter: fakeAdapter(),
  token: TOKEN,
  instanceUrl: "",
  transports: fakeTransports,
});

const SOURCE: BillingSource = { provider: "STRIPE", instanceUrl: "", externalId: "in_1", url: null };
const INVOICE: BillingInvoice = {
  source: SOURCE,
  kind: "INVOICE",
  creditNoteForId: null,
  customerId: "cus_1",
  number: "F-1",
  status: "OPEN",
  currency: "EUR",
  total: "120.00",
  tax: null,
  amountPaid: "0.00",
  amountDue: "120.00",
  issuedAt: new Date("2026-10-01T00:00:00Z"),
  dueAt: null,
  lines: [{ externalId: "l1", description: null, quantity: null, amount: "120.00", periodStart: null, periodEnd: null }],
};

describe("error taxonomy", () => {
  const classify = (status: number, headers: Record<string, string> = {}) =>
    classifyBillingResponse(new Response(null, { status, headers }), "Fake");

  it("maps provider statuses to the shared codes", () => {
    expect(classify(401).code).toBe("UNAUTHORIZED");
    expect(classify(403).code).toBe("FORBIDDEN");
    expect(classify(404).code).toBe("NOT_FOUND");
    expect(classify(500).code).toBe("HTTP_ERROR");
    const limited = classify(429, { "retry-after": "12" });
    expect(limited.code).toBe("RATE_LIMITED");
    expect(limited.details.retryAfterSeconds).toBe(12);
  });

  it("keeps the safe message free of any key", () => {
    expect(classify(401).toSafeMessage()).not.toContain(TOKEN);
  });
});

describe("record validation", () => {
  it("accepts a valid invoice and credit note", () => {
    expect(() => assertBillingInvoice(INVOICE)).not.toThrow();
    expect(() => assertBillingInvoice({ ...INVOICE, kind: "CREDIT_NOTE", creditNoteForId: "in_0" })).not.toThrow();
  });

  it("refuses a missing or signed amount: unknown is never zero, direction comes from the type", () => {
    expect(() => assertBillingInvoice({ ...INVOICE, total: undefined })).toThrow(ProviderError);
    expect(() => assertBillingInvoice({ ...INVOICE, total: "-120.00" })).toThrow(/Facture/);
    expect(() => assertBillingInvoice({ ...INVOICE, amountDue: 120 })).toThrow(/Facture/);
    expect(() =>
      assertBillingRefund({ source: SOURCE, paymentId: "py_1", invoiceId: null, status: "SUCCEEDED", amount: "-5.00", currency: "EUR", createdAt: new Date() }),
    ).toThrow(/Remboursement/);
  });

  it("refuses an invoice pointing at another invoice, an unknown status or a bad line", () => {
    expect(() => assertBillingInvoice({ ...INVOICE, creditNoteForId: "in_0" })).toThrow(/Facture/);
    expect(() => assertBillingInvoice({ ...INVOICE, status: "PAID_OUT" })).toThrow(/Facture/);
    expect(() => assertBillingInvoice({ ...INVOICE, currency: "eur" })).toThrow(/Facture/);
    expect(() => assertBillingInvoice({ ...INVOICE, lines: [{ externalId: "l1" }] as never })).toThrow(/Facture/);
  });

  it("refuses records without a complete source", () => {
    expect(() => assertBillingCustomer({ source: { ...SOURCE, externalId: "" }, name: null, createdAt: new Date() })).toThrow(/Client/);
    expect(() =>
      assertBillingPayment({ source: { ...SOURCE, provider: "PAYPAL" } as never, invoiceId: null, customerId: null, status: "SUCCEEDED", amount: "1.00", currency: "EUR", createdAt: new Date() }),
    ).toThrow(/Paiement/);
  });
});

describe("contract shape", () => {
  it("has no write member", () => {
    for (const member of BILLING_ADAPTER_MEMBERS) {
      expect(member).not.toMatch(/create|update|delete|charge|pay(?!ments)|refund(?!s)|send|void/i);
    }
  });

  it("keys a record by provider, instance and provider id", () => {
    expect(billingSourceKey(SOURCE)).toBe("STRIPE||in_1");
    expect(billingSourceKey({ ...SOURCE, instanceUrl: "https://proxy.fake.test" })).not.toBe(billingSourceKey(SOURCE));
  });
});
