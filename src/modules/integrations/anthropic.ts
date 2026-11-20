import Decimal from "decimal.js";
import { ProviderError, requestJson } from "./adapter";
import {
  assertAiScope,
  assertCostRecord,
  assertUsageRecord,
  classifyAiResponse,
  collectAiPages,
  resolveAiBaseUrl,
  type AiCostRecord,
  type AiPage,
  type AiPageOutcome,
  type AiPageRequest,
  type AiProviderAdapter,
  type AiRequest,
  type AiScope,
  type AiUsageRecord,
  AiWarnings,
} from "./ai-adapter";

/**
 * Anthropic usage and cost adapter (M11-03).
 *
 * Reads the Usage and Cost Analytics API (`GET /organizations/analytics/usage` and
 * `/cost`, beta) with an **Admin API key**, read-only, metadata only: no prompt,
 * completion or content is ever requested. The legacy `usage_report/messages` and
 * `cost_report` are not used: Anthropic documents them as legacy.
 *
 * Rows are daily (`time_bucket_width=1d`), oldest first (`order_by=time&order=asc`), so
 * a cursor resumes a stable sequence. Usage is grouped by model, workspace and service
 * tier; costs additionally by cost type and token type. A dimension Anthropic returns
 * as `null` is absent from `dimensions`, i.e. unknown; `scopeId: null` means the
 * workspace is unknown (Anthropic gives no id for some usage), never "default".
 *
 * What the API does not report authoritatively becomes an `AiSyncWarning`, never a
 * silent drop or a zero (see `ANTHROPIC_WARNINGS`).
 */

export const ANTHROPIC_PUBLIC_BASE = "https://api.anthropic.com/v1";
export const ANTHROPIC_API_VERSION = "2026-10-21";
export const ANTHROPIC_ANALYTICS_BETA = "analytics-usage-cost-2026-08-24";

/** Groupings of the imported lines. Changing one changes every `externalId`. */
export const ANTHROPIC_USAGE_GROUP_BY = ["model", "workspace_id", "service_tier"] as const;
export const ANTHROPIC_COST_GROUP_BY = [...ANTHROPIC_USAGE_GROUP_BY, "cost_type", "token_type"] as const;

/** Anthropic refuses a request spanning more than 31 days. */
export const ANTHROPIC_MAX_WINDOW_DAYS = 31;
const DAY_MS = 86_400_000;
const ROWS_PER_PAGE = 1000;

/** Cost types Anthropic documents; another one is still imported, with a warning. */
const KNOWN_COST_TYPES = new Set(["tokens", "web_search", "code_execution", "session_usage"]);

export const ANTHROPIC_WARNINGS = {
  /** Usage without a model (code execution): the usage contract needs one, so the row is counted, not imported. Its cost is imported. */
  USAGE_WITHOUT_MODEL: "USAGE_WITHOUT_MODEL",
  /** Priority Tier usage: its tokens cost zero in the data, the commitment fee is billed outside it. */
  PRIORITY_TIER_NOT_PRICED: "PRIORITY_TIER_NOT_PRICED",
  /** A cost type Anthropic did not document when this adapter was written: imported as is. */
  UNKNOWN_COST_TYPE: "UNKNOWN_COST_TYPE",
  /** Anthropic has no data yet for the window: an empty result is not zero spend. */
  NO_DATA_YET: "NO_DATA_YET",
  /** Data refreshed before the end of the window: the last days are missing or partial. */
  DATA_NOT_YET_REFRESHED: "DATA_NOT_YET_REFRESHED",
} as const;

type Row = { starting_at?: unknown; ending_at?: unknown; group?: Record<string, unknown> | null; usage?: unknown; cost?: unknown };
type AnalyticsPage = { data?: unknown; has_more?: unknown; next_page?: unknown; data_refreshed_at?: unknown };
type UsageMetrics = {
  uncached_input_tokens?: unknown;
  cache_creation?: { ephemeral_1h_input_tokens?: unknown; ephemeral_5m_input_tokens?: unknown } | null;
  cache_read_input_tokens?: unknown;
  output_tokens?: unknown;
  requests?: unknown;
};
type CostMetrics = { amount?: unknown; currency?: unknown };
type WorkspaceList = { data?: unknown; has_more?: unknown; last_id?: unknown };

const invalid = (what: string) => new ProviderError("INVALID_RESPONSE", `Réponse Anthropic inattendue : ${what}.`);

function get<T>(request: AiRequest, path: string, query: URLSearchParams): Promise<T> {
  const base = resolveAiBaseUrl(request.instanceUrl, ANTHROPIC_PUBLIC_BASE);
  const search = query.toString();

  return requestJson<T>({
    url: `${base}${path}${search ? `?${search}` : ""}`,
    headers: {
      "x-api-key": request.token,
      "anthropic-version": ANTHROPIC_API_VERSION,
      "anthropic-beta": ANTHROPIC_ANALYTICS_BETA,
      accept: "application/json",
    },
    fetchImpl: request.fetchImpl ?? fetch,
    signal: request.signal,
    classifyError: (response) => classifyAiResponse(response, "Anthropic"),
  }).then(({ data }) => data);
}

const isoSeconds = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/, "Z");

function instant(value: unknown, what: string): Date {
  const date = typeof value === "string" ? new Date(value) : new Date(Number.NaN);
  if (Number.isNaN(date.getTime())) throw invalid(what);
  return date;
}

/** `null`, absent or empty means unknown; anything else must be text. */
function optionalText(value: unknown, what: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw invalid(what);
  return value;
}

function count(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw invalid(what);
  return value;
}

/**
 * Anthropic sends cost as a decimal string in **cents** (`"41280.000000"` is 412.80
 * USD). Shifted to the currency unit in exact decimals, never through a float.
 */
export function anthropicAmount(cents: unknown): string {
  if (typeof cents !== "string" || !/^-?\d+(\.\d+)?$/.test(cents)) throw invalid("montant");
  return new Decimal(cents).div(100).toFixed();
}

/**
 * Daily rows can only be compared with a stored window when both ends sit on a UTC
 * midnight (Anthropic rounds them down to the bucket), and one request spans 31 days
 * at most. Checked before any request, as a programming error.
 */
function assertWindow(request: AiPageRequest): void {
  const start = request.start.getTime();
  const end = request.end.getTime();

  if (!(start < end)) throw new RangeError("La fenêtre doit avoir une fin après son début.");
  if (start % DAY_MS !== 0 || end % DAY_MS !== 0) {
    throw new RangeError("La fenêtre Anthropic doit commencer et finir à minuit UTC.");
  }
  if (end - start > ANTHROPIC_MAX_WINDOW_DAYS * DAY_MS) {
    throw new RangeError(`La fenêtre Anthropic ne peut dépasser ${ANTHROPIC_MAX_WINDOW_DAYS} jours.`);
  }
}

type Normalise<T> = (row: Row, group: Record<string, unknown>, warnings: AiWarnings) => T | null;

async function readAnalytics<T>(
  request: AiPageRequest,
  path: string,
  groupBy: readonly string[],
  normalise: Normalise<T>,
): Promise<AiPageOutcome<T>> {
  assertWindow(request);

  const read = async (cursor: string | null) => {
    const warnings = new AiWarnings();
    const outcome = await collectAiPages({ ...request, cursor }, async (page): Promise<AiPage<T>> => {
      const query = new URLSearchParams({
        starting_at: isoSeconds(request.start),
        ending_at: isoSeconds(request.end),
        time_bucket_width: "1d",
        order_by: "time",
        order: "asc",
        limit: String(ROWS_PER_PAGE),
      });
      groupBy.forEach((field) => query.append("group_by[]", field));
      if (page) query.set("page", page);

      const body = await get<AnalyticsPage>(request, path, query);
      if (!Array.isArray(body?.data) || typeof body.has_more !== "boolean") throw invalid("page d'analyse");

      const refreshedAt = optionalText(body.data_refreshed_at, "date de rafraîchissement");
      if (refreshedAt === null) {
        if (body.data.length > 0) throw invalid("données sans date de rafraîchissement");
        warnings.add(ANTHROPIC_WARNINGS.NO_DATA_YET, null);
      } else if (instant(refreshedAt, "date de rafraîchissement") < request.end) {
        warnings.add(ANTHROPIC_WARNINGS.DATA_NOT_YET_REFRESHED, null);
      }

      const records = (body.data as Row[]).flatMap((row) => {
        const record = normalise(row, row?.group ?? {}, warnings);
        return record === null ? [] : [record];
      });

      const next = optionalText(body.next_page, "curseur");
      if (body.has_more && next === null) throw invalid("curseur manquant");
      return { records, nextCursor: body.has_more ? next : null };
    });

    const list = warnings.list();
    return list.length > 0 ? { ...outcome, warnings: list } : outcome;
  };

  try {
    return await read(request.cursor);
  } catch (error) {
    // HTTP 410: the cursor expired when Anthropic refreshed its data. Rows are upserted
    // by a stable key, so reading the window again from the start is safe; once only.
    if (error instanceof ProviderError && error.details.status === 410) return read(null);
    throw error;
  }
}

function period(row: Row) {
  return { periodStart: instant(row.starting_at, "début de période"), periodEnd: instant(row.ending_at, "fin de période") };
}

function groupDimensions(group: Record<string, unknown>, keys: Record<string, string>) {
  const dimensions: Record<string, string> = {};
  for (const [field, name] of Object.entries(keys)) {
    const value = optionalText(group[field], field);
    if (value) dimensions[name] = value;
  }
  return dimensions;
}

const externalId = (row: Row, group: Record<string, unknown>, fields: readonly string[]) =>
  [row.starting_at, ...fields.map((field) => group[field])].map((part) => (part ?? "") as string).join("|");

const normaliseUsage: Normalise<AiUsageRecord> = (row, group, warnings) => {
  const usage = (row?.usage ?? null) as UsageMetrics | null;
  if (usage === null || typeof usage !== "object") throw invalid("usage");

  const model = optionalText(group.model, "modèle");
  if (model === null) {
    warnings.add(ANTHROPIC_WARNINGS.USAGE_WITHOUT_MODEL);
    return null;
  }

  const dimensions = groupDimensions(group, { service_tier: "serviceTier" });
  if (dimensions.serviceTier === "priority") warnings.add(ANTHROPIC_WARNINGS.PRIORITY_TIER_NOT_PRICED);

  const record: AiUsageRecord = {
    externalId: externalId(row, group, ANTHROPIC_USAGE_GROUP_BY),
    scopeId: optionalText(group.workspace_id, "espace de travail"),
    model,
    ...period(row),
    // Every input token: uncached, written to cache and read from cache.
    inputTokens:
      count(usage.uncached_input_tokens, "jetons d'entrée") +
      count(usage.cache_creation?.ephemeral_5m_input_tokens, "jetons de cache") +
      count(usage.cache_creation?.ephemeral_1h_input_tokens, "jetons de cache") +
      count(usage.cache_read_input_tokens, "jetons lus en cache"),
    outputTokens: count(usage.output_tokens, "jetons de sortie"),
    cachedInputTokens: count(usage.cache_read_input_tokens, "jetons lus en cache"),
    reasoningTokens: null,
    requests: usage.requests === null || usage.requests === undefined ? null : count(usage.requests, "requêtes"),
    dimensions,
  };
  assertUsageRecord(record);
  return record;
};

const normaliseCost: Normalise<AiCostRecord> = (row, group, warnings) => {
  const cost = (row?.cost ?? null) as CostMetrics | null;
  if (cost === null || typeof cost !== "object" || typeof cost.currency !== "string") throw invalid("coût");

  const dimensions = groupDimensions(group, {
    service_tier: "serviceTier",
    cost_type: "costType",
    token_type: "tokenType",
  });
  if (dimensions.costType && !KNOWN_COST_TYPES.has(dimensions.costType)) {
    warnings.add(ANTHROPIC_WARNINGS.UNKNOWN_COST_TYPE);
  }

  const record: AiCostRecord = {
    externalId: externalId(row, group, ANTHROPIC_COST_GROUP_BY),
    scopeId: optionalText(group.workspace_id, "espace de travail"),
    model: optionalText(group.model, "modèle"),
    ...period(row),
    // `amount` is after discounts and before credits; credits are not in this data.
    amount: anthropicAmount(cost.amount),
    currency: cost.currency.toUpperCase(),
    dimensions,
  };
  assertCostRecord(record);
  return record;
};

async function listWorkspaces(request: AiRequest, maxPages: number): Promise<AiScope[]> {
  const outcome = await collectAiPages({ cursor: null, maxPages }, async (cursor) => {
    const query = new URLSearchParams({ limit: "100" });
    if (cursor) query.set("after_id", cursor);
    const list = await get<WorkspaceList>(request, "/organizations/workspaces", query);

    if (!Array.isArray(list?.data)) throw invalid("liste d'espaces de travail");

    const records = (list.data as { id?: unknown; name?: unknown }[]).map((workspace) => {
      const scope = { externalId: workspace.id as string, name: workspace.name as string, kind: "workspace" as const };
      assertAiScope(scope);
      return scope;
    });
    const last = optionalText(list.last_id, "curseur d'espaces de travail");
    return { records, nextCursor: list.has_more === true ? last : null };
  });

  return outcome.records;
}

export const anthropicAdapter: AiProviderAdapter = {
  provider: "ANTHROPIC",
  // Only reads are made, but a Console Admin API key cannot be scoped down: it can also
  // manage the organization, so it must stay server-side and encrypted (M11-05).
  requiredScopes: ["admin:read"],

  async testAuth(request) {
    // `/organizations/me` also answers a regular key; listing workspaces needs an admin one.
    await listWorkspaces(request, 1);
    return { accountLabel: "Organisation Anthropic", grantedScopes: null };
  },

  async discover(request) {
    // ponytail: 10 pages of 100 workspaces; the default workspace is never listed.
    return { scopes: await listWorkspaces(request, 10), fetchedAt: new Date() };
  },

  listUsage: (request) =>
    readAnalytics(request, "/organizations/analytics/usage", ANTHROPIC_USAGE_GROUP_BY, normaliseUsage),

  listCosts: (request) =>
    readAnalytics(request, "/organizations/analytics/cost", ANTHROPIC_COST_GROUP_BY, normaliseCost),
};

/**
 * Organization total for the same window, without any grouping: the figure Anthropic
 * itself reports, against which imported lines are reconciled. Daily buckets, so both
 * reads round the window the same way.
 */
export async function listAnthropicOrganizationTotals(
  request: Omit<AiPageRequest, "cursor">,
): Promise<{ totals: Map<string, Decimal>; complete: boolean }> {
  const outcome = await readAnalytics({ ...request, cursor: null }, "/organizations/analytics/cost", [], normaliseCost);
  const totals = new Map<string, Decimal>();

  for (const record of outcome.records) {
    totals.set(record.currency, (totals.get(record.currency) ?? new Decimal(0)).plus(record.amount));
  }

  return { totals, complete: outcome.stoppedBy === null };
}
