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
 * OpenRouter analytics adapter (M11-04).
 *
 * Reads `GET /activity` with a **management key**, read-only, metadata only: no prompt,
 * completion or content. One activity row is one UTC day × model × provider endpoint,
 * with spend in USD, requests and token classes (prompt, completion, reasoning, cached).
 *
 * Attribution per API key: `/activity` is read once without filter (the organization
 * total) and once per key listed by `GET /keys` (`api_key_hash` filter). Each key's rows
 * become lines carrying that key; what the total holds beyond the listed keys (deleted
 * keys, keys beyond the listing bound) becomes a line **without** key — unknown, so it
 * stays unallocated — and an `UNATTRIBUTED_USAGE` warning. A key is never guessed.
 *
 * Not imported: app and end-user breakdowns, which only `POST /analytics/query` exposes
 * and whose metric names OpenRouter does not document; BYOK spend, billed by the
 * external provider (and possibly imported from it: counting it here would count it
 * twice), which is reported as a `BYOK_SPEND_NOT_IMPORTED` warning instead.
 *
 * `/activity` has no pagination and covers the last 30 completed UTC days. Pages are
 * therefore windows of `DAYS_PER_PAGE` days: each page reads the activity of the total
 * and of every key, keeps the rows of its days, and the cursor is the next page's
 * first day, so a stopped run resumes on a day boundary without gap or duplicate.
 */

export const OPENROUTER_PUBLIC_BASE = "https://openrouter.ai/api/v1";

const DAY_MS = 86_400_000;
const DAYS_PER_PAGE = 7;
const RETENTION_DAYS = 30;
/** Remainders below this, in USD, with no request nor token, are float noise, not usage. */
const NOISE = new Decimal("0.000001");

export const OPENROUTER_WARNINGS = {
  /** Usage of no listed key (deleted key...): imported without key, so unallocated. */
  UNATTRIBUTED_USAGE: "UNATTRIBUTED_USAGE",
  /** BYOK spend exists: billed by the external provider, not imported here. */
  BYOK_SPEND_NOT_IMPORTED: "BYOK_SPEND_NOT_IMPORTED",
  /** Part of the window is older than the 30 days OpenRouter keeps: it reads as empty. */
  OUTSIDE_RETENTION: "OUTSIDE_RETENTION",
  /** The window includes today, which OpenRouter reports only once the day is over. */
  CURRENT_DAY_NOT_REPORTED: "CURRENT_DAY_NOT_REPORTED",
} as const;

type RawActivity = Record<string, unknown>;
type Key = { hash: string; name: string; workspaceId: string | null };

type Activity = {
  date: string;
  model: string;
  endpointId: string;
  provider: string;
  usage: Decimal;
  byok: Decimal;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
};

/** One imported line before it becomes a usage or a cost record. */
type Line = Activity & { key: Key | null };

const invalid = (what: string) => new ProviderError("INVALID_RESPONSE", `Réponse OpenRouter inattendue : ${what}.`);

function get<T>(request: AiRequest, path: string, query: URLSearchParams): Promise<T> {
  const base = resolveAiBaseUrl(request.instanceUrl, OPENROUTER_PUBLIC_BASE);
  const search = query.toString();

  return requestJson<T>({
    url: `${base}${path}${search ? `?${search}` : ""}`,
    headers: { authorization: `Bearer ${request.token}`, accept: "application/json" },
    fetchImpl: request.fetchImpl ?? fetch,
    signal: request.signal,
    classifyError: (response) => classifyAiResponse(response, "OpenRouter"),
  }).then(({ data }) => data);
}

const dayOf = (date: Date) => date.toISOString().slice(0, 10);

function text(value: unknown, what: string): string {
  if (typeof value !== "string" || value === "") throw invalid(what);
  return value;
}

function count(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw invalid(what);
  return value;
}

/** USD sent as a JSON number, read through its shortest decimal form, never as a float sum. */
export function openRouterAmount(value: unknown): Decimal {
  if (typeof value !== "number" || !Number.isFinite(value)) throw invalid("montant");
  return new Decimal(value);
}

function parseActivity(raw: RawActivity): Activity {
  const date = text(raw.date, "date");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw invalid("date");

  return {
    date,
    model: text(raw.model, "modèle"),
    endpointId: text(raw.endpoint_id, "endpoint"),
    provider: text(raw.provider_name, "fournisseur"),
    usage: openRouterAmount(raw.usage),
    byok: openRouterAmount(raw.byok_usage_inference),
    requests: count(raw.requests, "requêtes"),
    promptTokens: count(raw.prompt_tokens, "jetons d'entrée"),
    completionTokens: count(raw.completion_tokens, "jetons de sortie"),
    reasoningTokens: count(raw.reasoning_tokens, "jetons de raisonnement"),
    cachedTokens: count(raw.cached_tokens, "jetons en cache"),
  };
}

async function readActivity(request: AiRequest, keyHash: string | null): Promise<Activity[]> {
  const query = new URLSearchParams();
  if (keyHash) query.set("api_key_hash", keyHash);
  const body = await get<{ data?: unknown }>(request, "/activity", query);
  if (!Array.isArray(body?.data)) throw invalid("activité");
  return (body.data as RawActivity[]).map(parseActivity);
}

async function listKeys(request: AiRequest, maxPages: number): Promise<Key[]> {
  const outcome = await collectAiPages({ cursor: null, maxPages }, async (cursor) => {
    const offset = Number(cursor ?? 0);
    // Disabled and expired keys still carry past spend: they are listed too.
    const query = new URLSearchParams({ include_disabled: "true", include_expired: "true", offset: String(offset) });
    const body = await get<{ data?: unknown }>(request, "/keys", query);
    if (!Array.isArray(body?.data)) throw invalid("liste de clés");

    const records = (body.data as RawActivity[]).map((raw) => ({
      hash: text(raw.hash, "clé"),
      name: text(raw.name, "nom de clé"),
      workspaceId: typeof raw.workspace_id === "string" && raw.workspace_id ? raw.workspace_id : null,
    }));
    return { records, nextCursor: records.length === 0 ? null : String(offset + records.length) };
  });

  return outcome.records;
}

/**
 * Daily windows can only be compared with stored lines when both ends sit on a UTC
 * midnight. Checked before any request, as a programming error.
 */
function assertWindow(request: AiPageRequest): void {
  const start = request.start.getTime();
  const end = request.end.getTime();
  if (!(start < end)) throw new RangeError("La fenêtre doit avoir une fin après son début.");
  if (start % DAY_MS !== 0 || end % DAY_MS !== 0) {
    throw new RangeError("La fenêtre OpenRouter doit commencer et finir à minuit UTC.");
  }
}

function windowWarnings(request: AiPageRequest, warnings: AiWarnings, now: Date): void {
  const today = Math.floor(now.getTime() / DAY_MS) * DAY_MS;
  if (request.start.getTime() < today - RETENTION_DAYS * DAY_MS) warnings.add(OPENROUTER_WARNINGS.OUTSIDE_RETENTION, null);
  if (request.end.getTime() > today) warnings.add(OPENROUTER_WARNINGS.CURRENT_DAY_NOT_REPORTED, null);
}

const rowKey = (row: Activity) => `${row.date}|${row.model}|${row.endpointId}`;

/** The total minus every key's rows for the same day, model and endpoint. */
function remainders(total: Activity[], byKey: Activity[]): Activity[] {
  const rest = new Map(total.map((row) => [rowKey(row), { ...row }]));

  for (const row of byKey) {
    const left = rest.get(rowKey(row));
    if (!left) throw invalid("activité d'une clé absente du total");
    left.usage = left.usage.minus(row.usage);
    left.byok = left.byok.minus(row.byok);
    left.requests -= row.requests;
    left.promptTokens -= row.promptTokens;
    left.completionTokens -= row.completionTokens;
    left.reasoningTokens -= row.reasoningTokens;
    left.cachedTokens -= row.cachedTokens;
  }

  return [...rest.values()].filter((row) => {
    const counts = [row.requests, row.promptTokens, row.completionTokens, row.reasoningTokens, row.cachedTokens];
    if (counts.some((n) => n < 0)) throw invalid("activité par clé supérieure au total");
    return counts.some((n) => n > 0) || row.usage.abs().gt(NOISE);
  });
}

/**
 * Reads the lines of the window, one page per `DAYS_PER_PAGE` days. Keys are listed
 * once per run; each page reads the total and every key's activity.
 */
async function readLines<T>(
  request: AiPageRequest,
  toRecord: (line: Line) => T | null,
): Promise<AiPageOutcome<T>> {
  assertWindow(request);
  const warnings = new AiWarnings();
  windowWarnings(request, warnings, new Date());

  let keys: Key[] | null = null;

  const outcome = await collectAiPages(request, async (cursor) => {
    const from = cursor ? new Date(`${cursor}T00:00:00Z`) : request.start;
    if (Number.isNaN(from.getTime()) || from < request.start || from >= request.end) throw invalid("curseur");
    const to = new Date(Math.min(from.getTime() + DAYS_PER_PAGE * DAY_MS, request.end.getTime()));
    const inPage = (row: Activity) => row.date >= dayOf(from) && row.date < dayOf(to);

    // ponytail: 10 pages of keys; keys beyond the bound fall into the unattributed line.
    keys ??= await listKeys(request, 10);
    const total = (await readActivity(request, null)).filter(inPage);
    const lines: Line[] = [];
    const attributed: Activity[] = [];

    for (const key of keys) {
      for (const row of (await readActivity(request, key.hash)).filter(inPage)) {
        lines.push({ ...row, key });
        attributed.push(row);
      }
    }

    const rest = remainders(total, attributed);
    if (rest.length > 0) warnings.add(OPENROUTER_WARNINGS.UNATTRIBUTED_USAGE, rest.length);
    lines.push(...rest.map((row) => ({ ...row, key: null })));

    const byok = total.filter((row) => row.byok.gt(0)).length;
    if (byok > 0) warnings.add(OPENROUTER_WARNINGS.BYOK_SPEND_NOT_IMPORTED, byok);

    const records = lines.flatMap((line) => {
      const record = toRecord(line);
      return record === null ? [] : [record];
    });
    return { records, nextCursor: to < request.end ? dayOf(to) : null };
  });

  const list = warnings.list();
  return list.length > 0 ? { ...outcome, warnings: list } : outcome;
}

function common(line: Line) {
  const dimensions: Record<string, string> = { provider: line.provider, endpointId: line.endpointId };
  if (line.key) dimensions.apiKeyId = line.key.hash;
  if (line.key?.workspaceId) dimensions.workspaceId = line.key.workspaceId;

  const periodStart = new Date(`${line.date}T00:00:00Z`);
  return {
    externalId: [line.date, line.model, line.endpointId, line.key?.hash ?? ""].join("|"),
    // The key is the scope `discover` lists; `null` is usage of no known key.
    scopeId: line.key?.hash ?? null,
    periodStart,
    periodEnd: new Date(periodStart.getTime() + DAY_MS),
    dimensions,
  };
}

function toUsage(line: Line): AiUsageRecord | null {
  if (line.requests === 0 && line.promptTokens === 0 && line.completionTokens === 0) return null;

  const record: AiUsageRecord = {
    ...common(line),
    model: line.model,
    inputTokens: line.promptTokens,
    outputTokens: line.completionTokens,
    cachedInputTokens: line.cachedTokens,
    reasoningTokens: line.reasoningTokens,
    requests: line.requests,
  };
  assertUsageRecord(record);
  return record;
}

function toCost(line: Line): AiCostRecord {
  const record: AiCostRecord = {
    ...common(line),
    model: line.model,
    // OpenRouter credits spent; BYOK spend is billed elsewhere (see the module comment).
    amount: line.usage.toFixed(),
    currency: "USD",
  };
  assertCostRecord(record);
  return record;
}

export const openRouterAdapter: AiProviderAdapter = {
  provider: "OPENROUTER",
  // A management key: OpenRouter has no narrower key for activity. Only reads are made,
  // but the key can also create and delete keys, so it stays server-side and encrypted (M11-05).
  requiredScopes: ["management:read"],

  async testAuth(request) {
    const body = await get<{ data?: { is_management_key?: unknown } }>(request, "/key", new URLSearchParams());
    if (typeof body?.data?.is_management_key !== "boolean") throw invalid("clé courante");
    if (!body.data.is_management_key) {
      throw new ProviderError("FORBIDDEN", "Clé OpenRouter sans droit de gestion : l'activité n'est pas lisible.");
    }
    return { accountLabel: "Compte OpenRouter", grantedScopes: null };
  },

  async discover(request) {
    const scopes: AiScope[] = (await listKeys(request, 10)).map((key) => ({
      externalId: key.hash,
      name: key.name,
      kind: "api_key",
    }));
    scopes.forEach(assertAiScope);
    return { scopes, fetchedAt: new Date() };
  },

  listUsage: (request) => readLines(request, toUsage),
  listCosts: (request) => readLines(request, toCost),
};

/**
 * Account total for the window, read without any key filter: the spend OpenRouter itself
 * reports, against which imported lines are reconciled. `/activity` has no pagination,
 * so a successful read is complete.
 */
export async function listOpenRouterTotals(
  request: Omit<AiPageRequest, "cursor">,
): Promise<{ totals: Map<string, Decimal>; complete: boolean }> {
  assertWindow({ ...request, cursor: null });
  const from = dayOf(request.start);
  const to = dayOf(request.end);
  const total = (await readActivity(request, null))
    .filter((row) => row.date >= from && row.date < to)
    .reduce((sum, row) => sum.plus(row.usage), new Decimal(0));

  return { totals: new Map([["USD", total]]), complete: true };
}
