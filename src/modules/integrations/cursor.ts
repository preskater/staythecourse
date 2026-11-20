import Decimal from "decimal.js";
import { ProviderError, requestJson } from "./adapter";
import {
  AiWarnings,
  assertAiScope,
  assertCostRecord,
  assertUsageRecord,
  classifyAiResponse,
  collectAiPages,
  resolveAiBaseUrl,
  type AiCostRecord,
  type AiPageOutcome,
  type AiPageRequest,
  type AiProviderAdapter,
  type AiRequest,
  type AiScope,
  type AiUsageRecord,
} from "./ai-adapter";

/**
 * Cursor team usage adapter (M11-07), best effort: nothing beyond what the API returns.
 *
 * Reads `GET /v2/teams/billing-items` with a Team API key (`read:*` scope), read-only,
 * metadata only: one item is one billed event with its member, model, token meters,
 * request count and price. Each item becomes one cost line and, when it carries token
 * meters and a model, one usage line, both keyed by Cursor's `billingItemId`.
 *
 * - Included spend vs overage: kept as the `usageType` dimension (`included`,
 *   `on_demand`, `credits`, `free`). Cursor prices included items at zero for
 *   non-Enterprise teams: the subscription covers them, its fee is not in this data
 *   (`PLAN_USAGE_NOT_PRICED` warning).
 * - Member: the principal's opaque id (`user_...`) only. Names and emails stay at Cursor.
 *
 * Not used, on purpose:
 * - `/teams/spend`: current billing cycle only, no window, so it cannot be re-run;
 * - `/teams/daily-usage-data`: activity counts without cost or per-model split;
 * - `/teams/filtered-usage-events`: the same events in cents, superseded by billing items;
 * - the Analytics API: its documentation could not be read, so nothing is assumed of it.
 * There is no independent windowed total to reconcile against (see `listCursorTotals`).
 */

export const CURSOR_PUBLIC_BASE = "https://api.cursor.com";

/** Cursor refuses a window longer than 31 days. */
export const CURSOR_MAX_WINDOW_DAYS = 31;
const DAY_MS = 86_400_000;
const ITEMS_PER_PAGE = 500;

export const CURSOR_WARNINGS = {
  /** Included, credit or free items priced at zero: the plan fee pays for them elsewhere. */
  PLAN_USAGE_NOT_PRICED: "PLAN_USAGE_NOT_PRICED",
  /** Token usage without a model: counted, not imported as usage (its cost is). */
  USAGE_WITHOUT_MODEL: "USAGE_WITHOUT_MODEL",
} as const;

type RawItem = {
  billingItemId?: unknown;
  eventTime?: unknown;
  product?: unknown;
  chargeCategory?: unknown;
  usageType?: unknown;
  principal?: { type?: unknown; id?: unknown } | null;
  usage?: Record<string, unknown> | null;
  pricing?: { currency?: unknown; contracted?: unknown } | null;
  displayExtras?: { model?: unknown } | null;
};

const invalid = (what: string) => new ProviderError("INVALID_RESPONSE", `Réponse Cursor inattendue : ${what}.`);

function get<T>(request: AiRequest, path: string, query: URLSearchParams): Promise<T> {
  const base = resolveAiBaseUrl(request.instanceUrl, CURSOR_PUBLIC_BASE);
  const search = query.toString();

  return requestJson<T>({
    url: `${base}${path}${search ? `?${search}` : ""}`,
    // Basic auth: the key as user name, an empty password.
    headers: { authorization: `Basic ${Buffer.from(`${request.token}:`).toString("base64")}`, accept: "application/json" },
    fetchImpl: request.fetchImpl ?? fetch,
    signal: request.signal,
    classifyError: (response) => classifyAiResponse(response, "Cursor"),
  }).then(({ data }) => data);
}

/** `null`, absent or empty means unknown; anything else must be text. */
function optionalText(value: unknown, what: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw invalid(what);
  return value;
}

/** Meters are whole numbers sent as strings; an absent meter is zero for this event. */
function meter(usage: Record<string, unknown>, name: string): number {
  const value = usage[name];
  if (value === undefined) return 0;
  if (typeof value !== "string" || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw invalid(`compteur ${name}`);
  return Number(value);
}

function assertWindow(request: AiPageRequest): void {
  const span = request.end.getTime() - request.start.getTime();
  if (!(span > 0)) throw new RangeError("La fenêtre doit avoir une fin après son début.");
  if (span > CURSOR_MAX_WINDOW_DAYS * DAY_MS) {
    throw new RangeError(`La fenêtre Cursor ne peut dépasser ${CURSOR_MAX_WINDOW_DAYS} jours.`);
  }
}

const rfc3339 = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/, "Z");

type Item = {
  id: string;
  at: Date;
  model: string | null;
  principalId: string | null;
  dimensions: Record<string, string>;
  amount: Decimal;
  currency: string;
  usage: Record<string, unknown> | null;
};

function parseItem(raw: RawItem): Item {
  const id = optionalText(raw?.billingItemId, "identifiant");
  const time = optionalText(raw?.eventTime, "date");
  const at = new Date(time ?? Number.NaN);
  if (id === null || Number.isNaN(at.getTime())) throw invalid("ligne de facturation");

  const contracted = raw.pricing?.contracted;
  if (typeof contracted !== "string" || !/^-?\d+(\.\d+)?$/.test(contracted)) throw invalid("montant");
  const currency = optionalText(raw.pricing?.currency, "devise");
  if (currency === null) throw invalid("devise");

  const dimensions: Record<string, string> = {};
  for (const [name, value] of [
    ["product", raw.product],
    ["usageType", raw.usageType],
    ["chargeCategory", raw.chargeCategory],
    ["principalType", raw.principal?.type],
  ] as const) {
    const text = optionalText(value, name);
    if (text) dimensions[name] = text;
  }

  const usage = raw.usage ?? null;
  if (usage !== null && typeof usage !== "object") throw invalid("usage");

  return {
    id,
    at,
    model: optionalText(raw.displayExtras?.model, "modèle"),
    principalId: optionalText(raw.principal?.id, "membre"),
    dimensions,
    amount: new Decimal(contracted),
    currency: currency.toUpperCase(),
    usage,
  };
}

async function readItems<T>(
  request: AiPageRequest,
  toRecord: (item: Item, warnings: AiWarnings) => T | null,
): Promise<AiPageOutcome<T>> {
  assertWindow(request);
  const warnings = new AiWarnings();

  const outcome = await collectAiPages(request, async (cursor) => {
    const query = new URLSearchParams({
      startTime: rfc3339(request.start),
      endTime: rfc3339(request.end),
      pageSize: String(ITEMS_PER_PAGE),
    });
    if (cursor) query.set("cursor", cursor);

    const body = await get<{ data?: unknown; pagination?: { hasMore?: unknown; nextCursor?: unknown } }>(
      request,
      "/v2/teams/billing-items",
      query,
    );
    if (!Array.isArray(body?.data) || typeof body.pagination?.hasMore !== "boolean") throw invalid("page de facturation");

    const records = (body.data as RawItem[]).flatMap((raw) => {
      const record = toRecord(parseItem(raw), warnings);
      return record === null ? [] : [record];
    });
    const next = optionalText(body.pagination.nextCursor, "curseur");
    if (body.pagination.hasMore && next === null) throw invalid("curseur manquant");
    return { records, nextCursor: body.pagination.hasMore ? next : null };
  });

  const list = warnings.list();
  return list.length > 0 ? { ...outcome, warnings: list } : outcome;
}

const common = (item: Item) => ({
  externalId: item.id,
  // The member (or service account, key, team) the event is billed to; `null` is unknown.
  scopeId: item.principalId,
  periodStart: item.at,
  // An event is an instant: the smallest period that contains it.
  periodEnd: new Date(item.at.getTime() + 1),
  dimensions: item.dimensions,
});

function toCost(item: Item, warnings: AiWarnings): AiCostRecord {
  if (item.amount.isZero() && item.dimensions.usageType !== "on_demand") {
    warnings.add(CURSOR_WARNINGS.PLAN_USAGE_NOT_PRICED);
  }
  const record: AiCostRecord = {
    ...common(item),
    model: item.model,
    amount: item.amount.toFixed(),
    currency: item.currency,
  };
  assertCostRecord(record);
  return record;
}

function toUsage(item: Item, warnings: AiWarnings): AiUsageRecord | null {
  if (item.usage === null) return null;

  const prompt = meter(item.usage, "prompt-text-tokens");
  const cacheRead = meter(item.usage, "cached-prompt-text-tokens");
  const cacheWrite = meter(item.usage, "cache-write-text-tokens");
  const output = meter(item.usage, "completion-text-tokens");
  const requests = item.usage.requests === undefined ? null : meter(item.usage, "requests");
  if (prompt + cacheRead + cacheWrite + output === 0 && !requests) return null;

  if (item.model === null) {
    warnings.add(CURSOR_WARNINGS.USAGE_WITHOUT_MODEL);
    return null;
  }

  const record: AiUsageRecord = {
    ...common(item),
    model: item.model,
    // The three input meters are priced separately by Cursor, so they are disjoint.
    inputTokens: prompt + cacheRead + cacheWrite,
    outputTokens: output,
    cachedInputTokens: cacheRead,
    reasoningTokens: null,
    requests,
  };
  assertUsageRecord(record);
  return record;
}

async function listMembers(request: AiRequest): Promise<AiScope[]> {
  const body = await get<{ teamMembers?: unknown }>(request, "/teams/members", new URLSearchParams());
  if (!Array.isArray(body?.teamMembers)) throw invalid("liste des membres");

  return (body.teamMembers as { id?: unknown; name?: unknown }[]).map((member) => {
    const id = optionalText(member?.id, "membre");
    // The name stays server-side; the email is never read into a scope.
    const scope = { externalId: id as string, name: optionalText(member?.name, "nom") ?? (id as string), kind: "member" as const };
    assertAiScope(scope);
    return scope;
  });
}

export const cursorAdapter: AiProviderAdapter = {
  provider: "CURSOR",
  requiredScopes: ["read:*"],

  async testAuth(request) {
    await listMembers(request);
    return { accountLabel: "Équipe Cursor", grantedScopes: null };
  },

  async discover(request) {
    // Removed members are listed too: their past spend is still attributed to them.
    return { scopes: await listMembers(request), fetchedAt: new Date() };
  },

  listUsage: (request) => readItems(request, toUsage),
  listCosts: (request) => readItems(request, toCost),
};

/**
 * Cursor gives no windowed total independent of its billing items (`/teams/spend` only
 * covers the current cycle): the reconciliation honestly stays `INCOMPLETE`.
 */
export async function listCursorTotals(): Promise<{ totals: Map<string, Decimal>; complete: boolean }> {
  return { totals: new Map(), complete: false };
}
