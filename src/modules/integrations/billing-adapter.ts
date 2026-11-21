import { parseRetryAfterSeconds, ProviderError } from "./adapter";
import { collectAiPages, type AiPage, type AiPageOutcome, type AiPageRequest, type AiRequest } from "./ai-adapter";

/**
 * Billing provider adapter contract (M16-01).
 *
 * Stripe (M16-02) and later billing providers sit behind this interface, like AI
 * providers behind `AiProviderAdapter` (M11-01), and follow the same conventions:
 * - the credential arrives in the request, is used server-side only and never appears
 *   in an error, a record or a cursor (storage is M11-05);
 * - errors are `ProviderError`s: `UNAUTHORIZED` (401, final, never retried),
 *   `FORBIDDEN` (403, the key lacks a read permission), `RATE_LIMITED` (429, with
 *   `retryAfterSeconds` when stated), `NETWORK`, `HTTP_ERROR`, `NOT_FOUND`,
 *   `INVALID_RESPONSE`;
 * - pagination is bounded and resumable with exactly the AI outcome rules: the
 *   shared `collectAiPages` enforces them (complete / `MAX_PAGES` / partial after a
 *   rate limit or network error on a later page; any other error is thrown);
 * - retries belong to the synchronisation (`createRetryingFetch`), not to adapters.
 *
 * Read-only, always: the interface has no write method and no payment initiation,
 * under any setting. `requiredScopes` lists read permissions of a restricted key.
 *
 * Idempotency: a record is identified by its `source` (provider + instance URL +
 * provider id). Re-running a listing returns the same ids; storing a record whose
 * source is already known updates it (an invoice later paid, a refund that
 * succeeded), never duplicates it.
 *
 * Amounts follow the revenue model (M10-02): exact decimal strings in major units
 * (`"120.50"`), positive magnitudes; whether money comes in or goes out is given by
 * the record type (payment vs refund) and the invoice `kind` (invoice vs credit note).
 * A missing amount is invalid, never zero.
 */

export const BILLING_PROVIDERS = ["STRIPE"] as const;
export type BillingProvider = (typeof BILLING_PROVIDERS)[number];

export type BillingRequest = AiRequest;
/** `start` inclusive, `end` exclusive, in UTC, on the record's creation instant. */
export type BillingPageRequest = AiPageRequest;
export type BillingPageOutcome<T> = AiPageOutcome<T>;
export type BillingPage<T> = AiPage<T>;
/** Shared bounded pagination: billing adapters only implement `fetchPage`. */
export const collectBillingPages = collectAiPages;

/** Where a record comes from: the reconciliation key, and a link back to it. */
export type BillingSource = {
  provider: BillingProvider;
  /** `""` for the provider's public API, otherwise the instance base URL. */
  instanceUrl: string;
  /** Stable provider identifier, kept as is. */
  externalId: string;
  /** Provider dashboard link, `null` when there is none. */
  url: string | null;
};

export type BillingAuthResult = {
  /** Display label of the account; never the credential. */
  accountLabel: string;
  grantedScopes: string[] | null;
  /** `false` for a provider test/sandbox account. */
  live: boolean;
};

/** Business data only: no e-mail, address or payment method is ever read. */
export type BillingCustomer = {
  source: BillingSource;
  /** `null` when the provider has no name for it. */
  name: string | null;
  createdAt: Date;
};

export const BILLING_INVOICE_KINDS = ["INVOICE", "CREDIT_NOTE"] as const;
export type BillingInvoiceKind = (typeof BILLING_INVOICE_KINDS)[number];

export const BILLING_INVOICE_STATUSES = ["DRAFT", "OPEN", "PAID", "VOID", "UNCOLLECTIBLE"] as const;
export type BillingInvoiceStatus = (typeof BILLING_INVOICE_STATUSES)[number];

export type BillingInvoiceLine = {
  externalId: string;
  description: string | null;
  /** Exact decimal string; `null` when the provider does not say. */
  quantity: string | null;
  amount: string;
  /** Service period of the line, when stated. */
  periodStart: Date | null;
  periodEnd: Date | null;
};

export type BillingInvoice = {
  source: BillingSource;
  kind: BillingInvoiceKind;
  /** Set on a credit note: the invoice it reduces. */
  creditNoteForId: string | null;
  customerId: string | null;
  number: string | null;
  status: BillingInvoiceStatus;
  /** ISO 4217, uppercase. */
  currency: string;
  /** Total including tax. */
  total: string;
  /** `null` when the provider does not split the tax. */
  tax: string | null;
  amountPaid: string;
  amountDue: string;
  /** `null` while a draft is not issued. */
  issuedAt: Date | null;
  dueAt: Date | null;
  /** Every line: an adapter reads all of them or fails, never a silent subset. */
  lines: BillingInvoiceLine[];
};

export const BILLING_PAYMENT_STATUSES = ["PENDING", "SUCCEEDED", "FAILED"] as const;
export type BillingPaymentStatus = (typeof BILLING_PAYMENT_STATUSES)[number];

export type BillingPayment = {
  source: BillingSource;
  invoiceId: string | null;
  customerId: string | null;
  status: BillingPaymentStatus;
  amount: string;
  currency: string;
  createdAt: Date;
};

export const BILLING_REFUND_STATUSES = ["PENDING", "SUCCEEDED", "FAILED", "CANCELLED"] as const;
export type BillingRefundStatus = (typeof BILLING_REFUND_STATUSES)[number];

export type BillingRefund = {
  source: BillingSource;
  paymentId: string;
  invoiceId: string | null;
  status: BillingRefundStatus;
  amount: string;
  currency: string;
  createdAt: Date;
};

/** The whole interface: reads only. The contract suite refuses any other method. */
export interface BillingProviderAdapter {
  readonly provider: BillingProvider;
  /** Read permissions of a restricted key; never a write permission. */
  readonly requiredScopes: readonly string[];
  testAuth(request: BillingRequest): Promise<BillingAuthResult>;
  listCustomers(request: BillingPageRequest): Promise<BillingPageOutcome<BillingCustomer>>;
  listInvoices(request: BillingPageRequest): Promise<BillingPageOutcome<BillingInvoice>>;
  listPayments(request: BillingPageRequest): Promise<BillingPageOutcome<BillingPayment>>;
  listRefunds(request: BillingPageRequest): Promise<BillingPageOutcome<BillingRefund>>;
}

export const BILLING_ADAPTER_MEMBERS = [
  "provider",
  "requiredScopes",
  "testAuth",
  "listCustomers",
  "listInvoices",
  "listPayments",
  "listRefunds",
] as const;

/** Default HTTP status mapping for billing providers; adapters may refine it. */
export function classifyBillingResponse(response: Response, providerLabel: string): ProviderError {
  const status = response.status;

  if (status === 401) {
    return new ProviderError("UNAUTHORIZED", `Clé ${providerLabel} invalide ou révoquée.`, { status });
  }
  if (status === 403) {
    return new ProviderError("FORBIDDEN", `Clé ${providerLabel} sans permission de lecture.`, { status });
  }
  if (status === 404) {
    return new ProviderError("NOT_FOUND", `Ressource ${providerLabel} introuvable.`, { status });
  }
  if (status === 429) {
    return new ProviderError("RATE_LIMITED", `Quota ${providerLabel} atteint.`, {
      status,
      retryAfterSeconds: parseRetryAfterSeconds(response),
    });
  }

  return new ProviderError("HTTP_ERROR", `Erreur ${providerLabel}.`, { status });
}

const MAGNITUDE = /^\d+(\.\d+)?$/;
const CURRENCY = /^[A-Z]{3}$/;

type Loose<T> = Partial<Record<keyof T, unknown>>;

const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const isTextOrNull = (value: unknown) => value === null || isText(value);
const isMagnitude = (value: unknown) => typeof value === "string" && MAGNITUDE.test(value);
const isInstant = (value: unknown) => value instanceof Date && !Number.isNaN(value.getTime());
const isInstantOrNull = (value: unknown) => value === null || isInstant(value);
const isOneOf = (values: readonly string[], value: unknown) => typeof value === "string" && values.includes(value);
const isCurrency = (value: unknown) => typeof value === "string" && CURRENCY.test(value);

function invalid(what: string): ProviderError {
  return new ProviderError("INVALID_RESPONSE", `${what} incomplet ou invalide.`);
}

function isSource(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const source = value as Loose<BillingSource>;
  return (
    isOneOf(BILLING_PROVIDERS, source.provider) &&
    typeof source.instanceUrl === "string" &&
    isText(source.externalId) &&
    isTextOrNull(source.url)
  );
}

export function assertBillingCustomer(record: Loose<BillingCustomer>): void {
  if (!isSource(record.source) || !isTextOrNull(record.name) || !isInstant(record.createdAt)) {
    throw invalid("Client");
  }
}

function isLine(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const line = value as Loose<BillingInvoiceLine>;
  return (
    isText(line.externalId) &&
    isTextOrNull(line.description) &&
    (line.quantity === null || isMagnitude(line.quantity)) &&
    isMagnitude(line.amount) &&
    isInstantOrNull(line.periodStart) &&
    isInstantOrNull(line.periodEnd)
  );
}

export function assertBillingInvoice(record: Loose<BillingInvoice>): void {
  if (
    !isSource(record.source) ||
    !isOneOf(BILLING_INVOICE_KINDS, record.kind) ||
    // Only a credit note points at the invoice it reduces.
    (record.kind === "CREDIT_NOTE" ? !isTextOrNull(record.creditNoteForId) : record.creditNoteForId !== null) ||
    !isTextOrNull(record.customerId) ||
    !isTextOrNull(record.number) ||
    !isOneOf(BILLING_INVOICE_STATUSES, record.status) ||
    !isCurrency(record.currency) ||
    !isMagnitude(record.total) ||
    !(record.tax === null || isMagnitude(record.tax)) ||
    !isMagnitude(record.amountPaid) ||
    !isMagnitude(record.amountDue) ||
    !isInstantOrNull(record.issuedAt) ||
    !isInstantOrNull(record.dueAt) ||
    !Array.isArray(record.lines) ||
    !record.lines.every(isLine)
  ) {
    throw invalid("Facture");
  }
}

export function assertBillingPayment(record: Loose<BillingPayment>): void {
  if (
    !isSource(record.source) ||
    !isTextOrNull(record.invoiceId) ||
    !isTextOrNull(record.customerId) ||
    !isOneOf(BILLING_PAYMENT_STATUSES, record.status) ||
    !isMagnitude(record.amount) ||
    !isCurrency(record.currency) ||
    !isInstant(record.createdAt)
  ) {
    throw invalid("Paiement");
  }
}

export function assertBillingRefund(record: Loose<BillingRefund>): void {
  if (
    !isSource(record.source) ||
    !isText(record.paymentId) ||
    !isTextOrNull(record.invoiceId) ||
    !isOneOf(BILLING_REFUND_STATUSES, record.status) ||
    !isMagnitude(record.amount) ||
    !isCurrency(record.currency) ||
    !isInstant(record.createdAt)
  ) {
    throw invalid("Remboursement");
  }
}

/** The reconciliation key of a record; equal keys are the same provider object. */
export function billingSourceKey(source: BillingSource): string {
  return `${source.provider}|${source.instanceUrl}|${source.externalId}`;
}
