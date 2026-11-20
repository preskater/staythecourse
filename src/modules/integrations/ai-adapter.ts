import { parseRetryAfterSeconds, ProviderError } from "./adapter";

/**
 * AI provider adapter contract (M11-01).
 *
 * OpenAI, Anthropic, OpenRouter and later providers each sit behind this interface,
 * the same way GitHub and GitLab sit behind `IntegrationAdapter`: the adapter owns
 * authentication, pagination and error mapping, the rest of the application only
 * sees normalised usage and cost records that can feed the cost ledger (M9-02).
 *
 * Read-only: no adapter writes to a provider, sends a prompt or reads a completion.
 *
 * Conventions every adapter follows (and `describeAiAdapterContract` checks):
 * - the credential arrives in the request, is used server-side only and never
 *   appears in an error message, a record or a cursor (storage is M11-05);
 * - pagination is bounded by `maxPages` and resumable through an opaque cursor that
 *   the caller persists per connection;
 * - errors are `ProviderError`s with this taxonomy:
 *   - `UNAUTHORIZED`: credential invalid or revoked (HTTP 401). Final, never retried;
 *     the connection must be marked in error and stored data left untouched.
 *   - `FORBIDDEN`: credential valid but lacks the usage/cost read permission (HTTP 403).
 *   - `RATE_LIMITED`: quota refused (HTTP 429), with `retryAfterSeconds` when stated.
 *   - `NETWORK`, `HTTP_ERROR`, `NOT_FOUND`, `INVALID_RESPONSE` as for code providers.
 * - outcomes of a listing:
 *   - complete: every page read, `nextCursor` is `null`;
 *   - partial (bound reached): `stoppedBy: "MAX_PAGES"`, `nextCursor` resumes;
 *   - partial (rate limit or network after at least one page): the pages already
 *     read are returned, `stoppedBy` holds the error code and `nextCursor` points
 *     at the failed page, so a re-run resumes without gaps;
 *   - any error on the first page, and `UNAUTHORIZED`/`FORBIDDEN`/`INVALID_RESPONSE`
 *     on any page, is thrown: nothing half-validated is returned.
 * - retries are not done by adapters: the synchronisation wraps the injected fetch
 *   with `createRetryingFetch` (retry.ts), which already retries 429 and 5xx with a
 *   bounded wait, exactly as for GitHub and GitLab.
 * - re-running the same request returns the same `externalId`s, which are the
 *   reconciliation key: storing a record twice must update, never duplicate.
 */

/**
 * `CUSTOM` covers a self-hosted or less common provider (an internal gateway, an
 * OpenAI-compatible server...): it has no public API, so its connection must give
 * an `instanceUrl`, like a self-hosted GitLab.
 */
export const AI_PROVIDERS = ["OPENAI", "ANTHROPIC", "OPENROUTER", "CUSTOM"] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

export type AiRequest = {
  /** Provider credential. Server-side only. */
  token: string;
  /**
   * Base URL of the provider API. Empty string means the provider's public API;
   * required for `CUSTOM`. Resolve it with `resolveAiBaseUrl`.
   */
  instanceUrl: string;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
};

export type AiPageRequest = AiRequest & {
  /** Instants in UTC; `start` inclusive, `end` exclusive. */
  start: Date;
  end: Date;
  /** Cursor returned by a previous outcome; `null` starts from the first page. */
  cursor: string | null;
  /** Bounds one run so it cannot loop forever. */
  maxPages?: number;
};

export const DEFAULT_AI_MAX_PAGES = 20;

export type AiAuthResult = {
  /** Display label of the account or organisation; never the credential. */
  accountLabel: string;
  /** Permissions the provider reports for this credential, when it says. */
  grantedScopes: string[] | null;
};

/** A project, workspace or API key the credential can see. */
export type AiScope = {
  externalId: string;
  name: string;
  kind: "organization" | "project" | "workspace" | "api_key";
};

export type AiDiscovery = {
  scopes: AiScope[];
  fetchedAt: Date;
};

export type AiUsageRecord = {
  /** Stable provider identifier: the reconciliation key. */
  externalId: string;
  /** `AiScope.externalId` the usage belongs to, `null` when the provider does not say. */
  scopeId: string | null;
  model: string;
  /** UTC instants of the bucket covered; `periodStart` inclusive, `periodEnd` exclusive. */
  periodStart: Date;
  periodEnd: Date;
  inputTokens: number;
  outputTokens: number;
  /** `null` when the provider does not report request counts. */
  requests: number | null;
  /** Further provider dimensions (service tier...); an absent key is **unknown**. */
  dimensions: Readonly<Record<string, string>>;
};

export type AiCostRecord = {
  externalId: string;
  scopeId: string | null;
  /** `null` when the provider bills without a per-model split. */
  model: string | null;
  periodStart: Date;
  periodEnd: Date;
  /**
   * Exact decimal as a string (for example `"12.3456"`), signed: negative is a
   * credit. Never a float, so it converts losslessly to `CostEntryInput.amount`.
   */
  amount: string;
  /** ISO 4217 code, uppercase. */
  currency: string;
  /**
   * Further provider dimensions (user, API key, line item, source...). A key that is
   * absent is **unknown**: an adapter never fills it with a guess.
   */
  dimensions: Readonly<Record<string, string>>;
};

export type AiPageStop = "MAX_PAGES" | "RATE_LIMITED" | "NETWORK";

/**
 * Something the provider reported that could not be imported as authoritative data,
 * or a known gap in what it reports (M11-03). Shown with the sync run, never dropped
 * silently. A code and a count only: never a credential, an amount or content.
 */
export type AiSyncWarning = {
  code: string;
  /** Provider rows concerned; `null` when the warning is about the window, not rows. */
  count: number | null;
};

export type AiPageOutcome<T> = {
  records: T[];
  /** Where to resume; `null` once every page has been read. */
  nextCursor: string | null;
  /** `null` when complete. */
  stoppedBy: AiPageStop | null;
  pagesRead: number;
  /** Retry hint when `stoppedBy` is `RATE_LIMITED` and the provider stated one. */
  retryAfterSeconds?: number;
  /** Absent or empty when the adapter has nothing to flag. */
  warnings?: AiSyncWarning[];
  fetchedAt: Date;
};

export interface AiProviderAdapter {
  readonly provider: AiProvider;
  /** Read-only permissions only: usage and cost display never asks for more. */
  readonly requiredScopes: readonly string[];
  testAuth(request: AiRequest): Promise<AiAuthResult>;
  discover(request: AiRequest): Promise<AiDiscovery>;
  /**
   * Absent when the adapter does not import usage: the interface must then say "not
   * tracked" rather than show an empty list, which would read as "no usage".
   */
  listUsage?(request: AiPageRequest): Promise<AiPageOutcome<AiUsageRecord>>;
  listCosts(request: AiPageRequest): Promise<AiPageOutcome<AiCostRecord>>;
}

/** One page as an adapter reads it: validated records and the next cursor. */
export type AiPage<T> = { records: T[]; nextCursor: string | null };

/**
 * Shared bounded pagination: adapters only implement `fetchPage`, so the outcome
 * rules above are enforced once for every provider.
 */
export async function collectAiPages<T>(
  request: Pick<AiPageRequest, "cursor" | "maxPages">,
  fetchPage: (cursor: string | null) => Promise<AiPage<T>>,
): Promise<AiPageOutcome<T>> {
  const maxPages = request.maxPages ?? DEFAULT_AI_MAX_PAGES;

  if (!Number.isInteger(maxPages) || maxPages < 1) {
    throw new RangeError("maxPages doit être un entier positif.");
  }

  const records: T[] = [];
  let cursor = request.cursor;
  let pagesRead = 0;

  while (pagesRead < maxPages) {
    let page: AiPage<T>;

    try {
      page = await fetchPage(cursor);
    } catch (error) {
      const resumable =
        pagesRead > 0 &&
        error instanceof ProviderError &&
        (error.code === "RATE_LIMITED" || error.code === "NETWORK");

      if (!resumable) {
        throw error;
      }

      return {
        records,
        nextCursor: cursor,
        stoppedBy: error.code as AiPageStop,
        pagesRead,
        retryAfterSeconds: error.details.retryAfterSeconds,
        fetchedAt: new Date(),
      };
    }

    records.push(...page.records);
    pagesRead += 1;

    if (page.nextCursor === null) {
      return { records, nextCursor: null, stoppedBy: null, pagesRead, fetchedAt: new Date() };
    }

    if (page.nextCursor === cursor) {
      // A provider repeating its cursor would otherwise loop until the bound.
      throw new ProviderError("INVALID_RESPONSE", "Curseur de pagination répété.");
    }

    cursor = page.nextCursor;
  }

  return { records, nextCursor: cursor, stoppedBy: "MAX_PAGES", pagesRead, fetchedAt: new Date() };
}

/**
 * Base URL an adapter calls: the configured `instanceUrl`, or `publicBase` when it is
 * empty. `publicBase` is `null` for a provider without a public API (`CUSTOM`), which
 * then requires an `instanceUrl`.
 */
export function resolveAiBaseUrl(instanceUrl: string, publicBase: string | null): string {
  const trimmed = instanceUrl.trim().replace(/\/+$/, "");

  if (trimmed === "") {
    if (publicBase === null) {
      throw new ProviderError("INVALID_RESPONSE", "URL du fournisseur personnalisé manquante.");
    }
    return publicBase;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ProviderError("INVALID_RESPONSE", "URL du fournisseur IA invalide.");
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new ProviderError("INVALID_RESPONSE", "L'URL du fournisseur IA doit utiliser http ou https.");
  }
  // The credential travels in a header: never let a URL carry its own userinfo.
  if (parsed.username || parsed.password) {
    throw new ProviderError("INVALID_RESPONSE", "L'URL du fournisseur IA ne doit pas contenir d'identifiants.");
  }

  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
}

/** Default HTTP status mapping for AI providers; adapters may refine it. */
export function classifyAiResponse(response: Response, providerLabel: string): ProviderError {
  const status = response.status;

  if (status === 401) {
    return new ProviderError("UNAUTHORIZED", `Clé ${providerLabel} invalide ou révoquée.`, { status });
  }
  if (status === 403) {
    return new ProviderError(
      "FORBIDDEN",
      `Clé ${providerLabel} sans permission de lecture de l'usage.`,
      { status },
    );
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

const DECIMAL = /^-?\d+(\.\d+)?$/;
const CURRENCY = /^[A-Z]{3}$/;

const isText = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const isCount = (value: unknown): boolean =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

const isPeriod = (start: unknown, end: unknown): boolean =>
  start instanceof Date &&
  end instanceof Date &&
  !Number.isNaN(start.getTime()) &&
  !Number.isNaN(end.getTime()) &&
  start.getTime() < end.getTime();

const isDimensions = (value: unknown): boolean =>
  typeof value === "object" && value !== null && Object.values(value).every(isText);

function invalid(what: string): ProviderError {
  return new ProviderError("INVALID_RESPONSE", `${what} incomplet ou invalide.`);
}

/** Validates one normalised usage record, so a malformed payload fails loudly. */
export function assertUsageRecord(record: Partial<Record<keyof AiUsageRecord, unknown>>): void {
  if (
    !isText(record.externalId) ||
    !(record.scopeId === null || isText(record.scopeId)) ||
    !isText(record.model) ||
    !isPeriod(record.periodStart, record.periodEnd) ||
    !isCount(record.inputTokens) ||
    !isCount(record.outputTokens) ||
    !(record.requests === null || isCount(record.requests)) ||
    !isDimensions(record.dimensions)
  ) {
    throw invalid("Enregistrement d'usage");
  }
}

/**
 * Validates one normalised cost record. A missing amount is invalid, never zero:
 * a lost provider return is not a free month.
 */
export function assertCostRecord(record: Partial<Record<keyof AiCostRecord, unknown>>): void {
  if (
    !isText(record.externalId) ||
    !(record.scopeId === null || isText(record.scopeId)) ||
    !(record.model === null || isText(record.model)) ||
    !isPeriod(record.periodStart, record.periodEnd) ||
    typeof record.amount !== "string" ||
    !DECIMAL.test(record.amount) ||
    typeof record.currency !== "string" ||
    !CURRENCY.test(record.currency) ||
    !isDimensions(record.dimensions)
  ) {
    throw invalid("Enregistrement de coût");
  }
}

export function assertAiScope(scope: Partial<Record<keyof AiScope, unknown>>): void {
  if (
    !isText(scope.externalId) ||
    !isText(scope.name) ||
    !["organization", "project", "workspace", "api_key"].includes(scope.kind as string)
  ) {
    throw invalid("Périmètre");
  }
}
