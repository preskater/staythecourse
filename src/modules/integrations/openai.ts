import Decimal from "decimal.js";
import { ProviderError, requestJson } from "./adapter";
import {
  assertAiScope,
  assertCostRecord,
  classifyAiResponse,
  collectAiPages,
  resolveAiBaseUrl,
  type AiCostRecord,
  type AiPageOutcome,
  type AiPageRequest,
  type AiProviderAdapter,
  type AiRequest,
  type AiScope,
} from "./ai-adapter";

/**
 * OpenAI organization cost adapter (M11-02).
 *
 * Reads `GET /organization/costs` with an **admin key**, read-only, metadata only: no
 * prompt, completion or content is ever requested. Costs are daily buckets
 * (`bucket_width=1d`, the only width the API offers).
 *
 * Dimensions: the import groups by project, API key, line item and source. `user_id`
 * is deliberately left out: OpenAI rejects some `user_id` + `project_id` combinations
 * with HTTP 400, so the user dimension stays **unknown** rather than estimated.
 * A dimension OpenAI returns as `null` is absent from `dimensions`, i.e. unknown.
 */

export const OPENAI_PUBLIC_BASE = "https://api.openai.com/v1";

/** Grouping of the imported lines. Changing it changes every `externalId`. */
export const OPENAI_COST_GROUP_BY = ["project_id", "api_key_id", "line_item", "api_source"] as const;

/** Buckets (days) per page; OpenAI allows 1 to 180. */
const BUCKETS_PER_PAGE = 31;

type OpenAiCostResult = {
  amount?: { value?: unknown; currency?: unknown };
  project_id?: unknown;
  api_key_id?: unknown;
  line_item?: unknown;
  api_source?: unknown;
};

type OpenAiBucket = { start_time?: unknown; end_time?: unknown; results?: unknown };
type OpenAiPage = { data?: unknown; has_more?: unknown; next_page?: unknown };
type OpenAiProjectList = { data?: unknown; has_more?: unknown; last_id?: unknown };

const invalid = (what: string) => new ProviderError("INVALID_RESPONSE", `Réponse OpenAI inattendue : ${what}.`);

function get<T>(request: AiRequest, path: string, query: URLSearchParams): Promise<T> {
  const base = resolveAiBaseUrl(request.instanceUrl, OPENAI_PUBLIC_BASE);
  const search = query.toString();

  return requestJson<T>({
    url: `${base}${path}${search ? `?${search}` : ""}`,
    headers: { authorization: `Bearer ${request.token}`, accept: "application/json" },
    fetchImpl: request.fetchImpl ?? fetch,
    signal: request.signal,
    classifyError: (response) => classifyAiResponse(response, "OpenAI"),
  }).then(({ data }) => data);
}

const toUnixSeconds = (date: Date) => Math.floor(date.getTime() / 1000);

function fromUnixSeconds(value: unknown): Date {
  if (typeof value !== "number" || !Number.isInteger(value)) throw invalid("date de bucket");
  return new Date(value * 1000);
}

/** `null`, absent or empty means unknown; anything else must be text. */
function optionalText(value: unknown, what: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw invalid(what);
  return value;
}

/**
 * OpenAI sends the amount as a JSON number. It is read through its shortest decimal
 * representation (`0.06` stays `"0.06"`), never through float arithmetic.
 */
export function openAiAmount(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) throw invalid("montant");
  return new Decimal(value).toFixed();
}

function normaliseResult(raw: OpenAiCostResult, start: Date, end: Date): AiCostRecord {
  const projectId = optionalText(raw.project_id, "projet");
  const apiKeyId = optionalText(raw.api_key_id, "clé API");
  const lineItem = optionalText(raw.line_item, "ligne de facturation");
  const source = optionalText(raw.api_source, "source");
  const currency = raw.amount?.currency;

  if (typeof currency !== "string") throw invalid("devise");

  const dimensions: Record<string, string> = {};
  if (apiKeyId) dimensions.apiKeyId = apiKeyId;
  if (lineItem) dimensions.lineItem = lineItem;
  if (source) dimensions.source = source;

  const record: AiCostRecord = {
    // Stable for a given bucket and grouping: a re-run upserts the same line.
    externalId: [toUnixSeconds(start), projectId, apiKeyId, lineItem, source]
      .map((part) => part ?? "")
      .join("|"),
    scopeId: projectId,
    // OpenAI reports no model on costs; parsing it out of `line_item` would be a guess.
    model: null,
    periodStart: start,
    periodEnd: end,
    amount: openAiAmount(raw.amount?.value),
    currency: currency.toUpperCase(),
    dimensions,
  };
  assertCostRecord(record);
  return record;
}

function costQuery(request: AiPageRequest, cursor: string | null, groupBy: readonly string[]) {
  const query = new URLSearchParams({
    start_time: String(toUnixSeconds(request.start)),
    end_time: String(toUnixSeconds(request.end)),
    bucket_width: "1d",
    limit: String(BUCKETS_PER_PAGE),
  });
  groupBy.forEach((field) => query.append("group_by", field));
  if (cursor) query.set("page", cursor);
  return query;
}

async function readCostPages(request: AiPageRequest, groupBy: readonly string[]) {
  if (!(request.start.getTime() < request.end.getTime())) {
    throw new RangeError("La fenêtre de coûts doit avoir une fin après son début.");
  }

  return collectAiPages(request, async (cursor) => {
    const page = await get<OpenAiPage>(request, "/organization/costs", costQuery(request, cursor, groupBy));

    if (!Array.isArray(page?.data) || typeof page.has_more !== "boolean") throw invalid("page de coûts");

    const records = (page.data as OpenAiBucket[]).flatMap((bucket) => {
      if (!Array.isArray(bucket?.results)) throw invalid("bucket de coûts");
      const start = fromUnixSeconds(bucket.start_time);
      const end = fromUnixSeconds(bucket.end_time);
      return (bucket.results as OpenAiCostResult[]).map((result) => normaliseResult(result, start, end));
    });

    const next = optionalText(page.next_page, "curseur");
    if (page.has_more && next === null) throw invalid("curseur manquant");

    return { records, nextCursor: page.has_more ? next : null };
  });
}

async function listProjects(request: AiRequest, maxPages: number): Promise<AiScope[]> {
  const outcome = await collectAiPages({ cursor: null, maxPages }, async (cursor) => {
    const query = new URLSearchParams({ limit: "100" });
    if (cursor) query.set("after", cursor);
    const list = await get<OpenAiProjectList>(request, "/organization/projects", query);

    if (!Array.isArray(list?.data)) throw invalid("liste de projets");

    const records = (list.data as { id?: unknown; name?: unknown }[]).map((project) => {
      const scope = { externalId: project.id as string, name: project.name as string, kind: "project" as const };
      assertAiScope(scope);
      return scope;
    });
    const last = optionalText(list.last_id, "curseur de projets");
    return { records, nextCursor: list.has_more === true ? last : null };
  });

  return outcome.records;
}

export const openAiAdapter: AiProviderAdapter = {
  provider: "OPENAI",
  // Admin key restricted to read access on usage and projects.
  requiredScopes: ["api.usage.read", "api.management.read"],

  async testAuth(request) {
    // Listing one project is the cheapest call that needs an admin key.
    await listProjects(request, 1);
    return { accountLabel: "Organisation OpenAI", grantedScopes: null };
  },

  async discover(request) {
    // ponytail: 10 pages of 100 projects; raise when an organisation has more.
    return { scopes: await listProjects(request, 10), fetchedAt: new Date() };
  },

  listCosts: (request) => readCostPages(request, OPENAI_COST_GROUP_BY),
};

export type OpenAiOrganizationTotals = {
  /** Sum per uppercase currency, exact. */
  totals: Map<string, Decimal>;
  /** False when the bound or a refusal cut the read: the totals are then not comparable. */
  complete: boolean;
};

/**
 * Organization total for the same window, read without any grouping: the figure
 * OpenAI itself reports, against which imported lines are reconciled.
 */
export async function listOpenAiOrganizationTotals(
  request: Omit<AiPageRequest, "cursor">,
): Promise<OpenAiOrganizationTotals> {
  const outcome: AiPageOutcome<AiCostRecord> = await readCostPages({ ...request, cursor: null }, []);
  const totals = new Map<string, Decimal>();

  for (const record of outcome.records) {
    totals.set(record.currency, (totals.get(record.currency) ?? new Decimal(0)).plus(record.amount));
  }

  return { totals, complete: outcome.stoppedBy === null };
}
