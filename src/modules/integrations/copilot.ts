import { ProviderError, requestJson } from "./adapter";
import {
  assertAiScope,
  assertUsageRecord,
  classifyAiResponse,
  collectAiPages,
  resolveAiBaseUrl,
  type AiPageOutcome,
  type AiPageRequest,
  type AiProviderAdapter,
  type AiRequest,
  type AiScope,
  type AiUsageRecord,
} from "./ai-adapter";
import { API_BASE as GITHUB_PUBLIC_BASE, API_VERSION, classifyGitHubError } from "./github";

/**
 * GitHub Copilot adapter (M11-08), read-only, organization level.
 *
 * - Seats: `GET /orgs/{org}/copilot/billing` (breakdown) and `/billing/seats` (list,
 *   only **counted** to reconcile with the breakdown; no login is returned or kept).
 * - Activity: the daily `organization-1-day` usage-metrics report. GitHub answers with
 *   signed download links to NDJSON files; they are fetched **without** the token.
 *   Reports exist from 2025-12-12 and land about two UTC days after the day closes:
 *   a day without a report (HTTP 204) is absent, never zero.
 * - Costs: none. The API reports seats and plans, never a price, so `listCosts` is not
 *   implemented and the interface says "coût non suivi".
 *
 * Token: classic `read:org` (fine-grained: "View Organization Copilot Metrics", plus
 * organization owner rights for the seat endpoints). Activity is activity: no field
 * here measures productivity, and nothing per member is returned.
 */

/** Days per page: a month fits the default page bound and a page stays small. */
const DAYS_PER_PAGE = 7;
const SEATS_PER_PAGE = 100;
const MAX_SEAT_PAGES = 50;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const invalid = (what: string) =>
  new ProviderError("INVALID_RESPONSE", `Réponse GitHub Copilot inattendue : ${what}.`);

function classify(response: Response): ProviderError {
  // GitHub signals a spent quota with a 403; everything else follows the AI taxonomy.
  const github = classifyGitHubError(response);
  return github.code === "RATE_LIMITED" ? github : classifyAiResponse(response, "GitHub Copilot");
}

async function get<T>(request: AiRequest, path: string, query = new URLSearchParams()) {
  const base = resolveAiBaseUrl(request.instanceUrl, GITHUB_PUBLIC_BASE);
  const search = query.toString();
  return requestJson<T>({
    url: `${base}${path}${search ? `?${search}` : ""}`,
    headers: {
      authorization: `Bearer ${request.token}`,
      accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": API_VERSION,
    },
    fetchImpl: request.fetchImpl ?? fetch,
    signal: request.signal,
    classifyError: classify,
  });
}

function organizationOf(request: AiPageRequest | (AiRequest & { scopeId?: string })): string {
  const org = request.scopeId?.trim();
  if (!org || !/^[A-Za-z0-9-]+$/.test(org)) {
    throw new RangeError("Organisation GitHub (scopeId) manquante ou invalide.");
  }
  return org;
}

/** `null`/absent is unknown; anything else must be a non-negative integer. */
function count(value: unknown, what: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw invalid(what);
  return value;
}

function requiredCount(value: unknown, what: string): number {
  const parsed = count(value, what);
  if (parsed === null) throw invalid(what);
  return parsed;
}

const DAY_MS = 86_400_000;
const toDay = (date: Date) => date.toISOString().slice(0, 10);
const dayStart = (day: string) => new Date(`${day}T00:00:00Z`);
const nextDay = (day: string) => toDay(new Date(dayStart(day).getTime() + DAY_MS));

/**
 * Reads the NDJSON files behind the signed links. The token never travels to them:
 * they are pre-signed, and their host is not GitHub's API.
 */
async function download(request: AiRequest, links: string[]): Promise<Record<string, unknown>[]> {
  const records: Record<string, unknown>[] = [];

  for (const link of links) {
    let url: URL;
    try {
      url = new URL(link);
    } catch {
      throw invalid("lien de rapport");
    }
    if (url.protocol !== "https:") throw invalid("lien de rapport non chiffré");

    let response: Response;
    try {
      response = await (request.fetchImpl ?? fetch)(url, { method: "GET", signal: request.signal, cache: "no-store" });
    } catch {
      throw new ProviderError("NETWORK", "Rapport GitHub Copilot injoignable.");
    }
    if (!response.ok) {
      // A signed link answers for itself, not for the token: only a quota is special.
      throw response.status === 429
        ? classifyAiResponse(response, "GitHub Copilot")
        : new ProviderError("HTTP_ERROR", "Téléchargement du rapport GitHub Copilot refusé.", { status: response.status });
    }

    for (const line of (await response.text()).split("\n")) {
      if (line.trim() === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw invalid("ligne de rapport illisible");
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw invalid("ligne de rapport");
      records.push(parsed as Record<string, unknown>);
    }
  }

  return records;
}

type DayReport = { download_links?: unknown };

/** The organization record of one day, or `null` when GitHub has no report for it. */
async function readDay(request: AiPageRequest, org: string, day: string): Promise<Record<string, unknown> | null> {
  const { data, response } = await get<DayReport | null>(
    request,
    `/orgs/${org}/copilot/metrics/reports/organization-1-day`,
    new URLSearchParams({ day }),
  ).catch((error: unknown) => {
    // `requestJson` cannot read the empty body of a 204: a day without a report.
    if (error instanceof ProviderError && error.code === "INVALID_RESPONSE" && error.details.status === 204) {
      return { data: null, response: null };
    }
    throw error;
  });

  if (response === null || response.status === 204) return null;
  const links = data?.download_links;
  if (!Array.isArray(links) || !links.every((link) => typeof link === "string")) throw invalid("liens de rapport");
  if (links.length === 0) return null;

  const records = await download(request, links as string[]);
  const record = records.find((row) => row.day === undefined || row.day === day);
  if (!record) throw invalid("rapport sans le jour demandé");
  return record;
}

/** Shared day pagination: the cursor is the next `YYYY-MM-DD` to read. */
async function readDays<T>(
  request: AiPageRequest,
  toRecords: (org: string, day: string, record: Record<string, unknown>) => T[],
): Promise<AiPageOutcome<T>> {
  if (!(request.start.getTime() < request.end.getTime())) {
    throw new RangeError("La fenêtre d'activité doit avoir une fin après son début.");
  }
  const org = organizationOf(request);
  const last = toDay(new Date(request.end.getTime() - 1));

  if (request.cursor !== null && !DAY_PATTERN.test(request.cursor)) {
    throw new ProviderError("INVALID_RESPONSE", "Curseur d'activité invalide.");
  }

  return collectAiPages(request, async (cursor) => {
    const first = cursor ?? toDay(request.start);
    const records: T[] = [];
    let day = first;

    for (let index = 0; index < DAYS_PER_PAGE && day <= last; index += 1) {
      const record = await readDay(request, org, day);
      if (record) records.push(...toRecords(org, day, record));
      day = nextDay(day);
    }

    return { records, nextCursor: day <= last ? day : null };
  });
}

export type CopilotThirdPartyAgent = {
  /** GitHub's stable agent identifier: the key the agents module (M13) can match on. */
  agentId: string;
  agentName: string;
  interactions: number | null;
};

/** One organization day as GitHub reports it. `null` means GitHub did not say. */
export type CopilotDay = {
  externalId: string;
  organization: string;
  /** `YYYY-MM-DD`, UTC. */
  day: string;
  dailyActiveUsers: number;
  weeklyActiveUsers: number | null;
  monthlyActiveUsers: number | null;
  monthlyActiveAgentUsers: number | null;
  dailyActiveCloudAgentUsers: number | null;
  interactionCount: number | null;
  codeGenerationCount: number | null;
  codeAcceptanceCount: number | null;
  thirdPartyAgents: CopilotThirdPartyAgent[];
};

export function normaliseCopilotDay(org: string, day: string, raw: Record<string, unknown>): CopilotDay {
  const agents = raw.totals_by_3rd_party_agent ?? [];
  if (!Array.isArray(agents)) throw invalid("agents tiers");

  return {
    externalId: `${org}|${day}`,
    organization: org,
    day,
    dailyActiveUsers: requiredCount(raw.daily_active_users, "utilisateurs actifs du jour"),
    weeklyActiveUsers: count(raw.weekly_active_users, "utilisateurs actifs de la semaine"),
    monthlyActiveUsers: count(raw.monthly_active_users, "utilisateurs actifs du mois"),
    monthlyActiveAgentUsers: count(raw.monthly_active_agent_users, "utilisateurs du mode agent"),
    dailyActiveCloudAgentUsers: count(raw.daily_active_copilot_cloud_agent_users, "utilisateurs de l'agent cloud"),
    interactionCount: count(raw.user_initiated_interaction_count, "interactions"),
    codeGenerationCount: count(raw.code_generation_activity_count, "générations"),
    codeAcceptanceCount: count(raw.code_acceptance_activity_count, "acceptations"),
    thirdPartyAgents: (agents as Record<string, unknown>[]).map((agent) => {
      if (typeof agent?.agent_id !== "string" && typeof agent?.agent_id !== "number") throw invalid("identifiant d'agent");
      if (typeof agent.agent_name !== "string") throw invalid("nom d'agent");
      return {
        agentId: String(agent.agent_id),
        agentName: agent.agent_name,
        interactions: count(agent.user_initiated_interaction_count, "interactions d'agent"),
      };
    }),
  };
}

type TokenUsage = { prompt_tokens_sum?: unknown; output_tokens_sum?: unknown };
type ModelTotals = { model?: unknown; request_count?: unknown; token_usage?: TokenUsage };

/** Per-model usage of one day, summed across clients (IDE, CLI, github.com...). */
export function copilotUsageRecords(org: string, day: string, raw: Record<string, unknown>): AiUsageRecord[] {
  const clients = raw.totals_by_client ?? [];
  if (!Array.isArray(clients)) throw invalid("clients");
  const byModel = new Map<string, { input: number; output: number; requests: number }>();

  for (const client of clients as { totals_by_model?: unknown }[]) {
    const models = client?.totals_by_model ?? [];
    if (!Array.isArray(models)) throw invalid("modèles");
    for (const entry of models as ModelTotals[]) {
      if (typeof entry?.model !== "string" || entry.model === "") throw invalid("modèle");
      const sum = byModel.get(entry.model) ?? { input: 0, output: 0, requests: 0 };
      sum.input += requiredCount(entry.token_usage?.prompt_tokens_sum, "jetons d'entrée");
      sum.output += requiredCount(entry.token_usage?.output_tokens_sum, "jetons de sortie");
      sum.requests += requiredCount(entry.request_count, "requêtes");
      byModel.set(entry.model, sum);
    }
  }

  const periodStart = dayStart(day);
  return [...byModel].map(([model, sum]) => {
    const record: AiUsageRecord = {
      externalId: `${org}|${day}|${model}`,
      scopeId: org,
      model,
      periodStart,
      periodEnd: dayStart(nextDay(day)),
      inputTokens: sum.input,
      outputTokens: sum.output,
      requests: sum.requests,
    };
    assertUsageRecord(record);
    return record;
  });
}

/** Organization days of `[start, end)`, one report per day, resumable by day. */
export function listCopilotDays(request: AiPageRequest): Promise<AiPageOutcome<CopilotDay>> {
  return readDays(request, (org, day, raw) => [normaliseCopilotDay(org, day, raw)]);
}

export type CopilotSeats = {
  organization: string;
  planType: string | null;
  total: number;
  activeThisCycle: number;
  inactiveThisCycle: number;
  addedThisCycle: number;
  pendingInvitation: number;
  pendingCancellation: number;
  /** Seats counted in the seat list; `null` when the list was longer than the bound. */
  listedSeats: number | null;
};

type SeatBreakdown = Record<string, unknown>;

/**
 * Seat breakdown plus a count of the seat list, so the two provider figures can be
 * reconciled. The list carries member logins: it is counted here and dropped.
 */
export async function readCopilotSeats(request: AiRequest & { scopeId?: string }): Promise<CopilotSeats> {
  const org = organizationOf(request);
  const { data } = await get<{ seat_breakdown?: SeatBreakdown; plan_type?: unknown }>(request, `/orgs/${org}/copilot/billing`);
  const breakdown = data?.seat_breakdown;
  if (typeof breakdown !== "object" || breakdown === null) throw invalid("répartition des sièges");

  let listedSeats: number | null = 0;
  for (let page = 1; ; page += 1) {
    if (page > MAX_SEAT_PAGES) {
      // ponytail: 5,000 seats; raise MAX_SEAT_PAGES for a larger organization.
      listedSeats = null;
      break;
    }
    const { data: list } = await get<{ seats?: unknown }>(
      request,
      `/orgs/${org}/copilot/billing/seats`,
      new URLSearchParams({ per_page: String(SEATS_PER_PAGE), page: String(page) }),
    );
    if (!Array.isArray(list?.seats)) throw invalid("liste des sièges");
    listedSeats += list.seats.length;
    if (list.seats.length < SEATS_PER_PAGE) break;
  }

  return {
    organization: org,
    planType: typeof data.plan_type === "string" ? data.plan_type : null,
    total: requiredCount(breakdown.total, "sièges"),
    activeThisCycle: requiredCount(breakdown.active_this_cycle, "sièges actifs"),
    inactiveThisCycle: requiredCount(breakdown.inactive_this_cycle, "sièges inactifs"),
    addedThisCycle: requiredCount(breakdown.added_this_cycle, "sièges ajoutés"),
    pendingInvitation: requiredCount(breakdown.pending_invitation, "invitations en attente"),
    pendingCancellation: requiredCount(breakdown.pending_cancellation, "annulations en attente"),
    listedSeats,
  };
}

async function listOrganizations(request: AiRequest, maxPages: number): Promise<AiScope[]> {
  const outcome = await collectAiPages({ cursor: null, maxPages }, async (cursor) => {
    const page = Number(cursor ?? "1");
    const { data } = await get<unknown>(
      request,
      "/user/orgs",
      new URLSearchParams({ per_page: "100", page: String(page) }),
    );
    if (!Array.isArray(data)) throw invalid("liste d'organisations");
    const records = (data as { login?: unknown }[]).map((org) => {
      const scope = { externalId: org?.login as string, name: org?.login as string, kind: "organization" as const };
      assertAiScope(scope);
      return scope;
    });
    return { records, nextCursor: records.length === 100 ? String(page + 1) : null };
  });
  return outcome.records;
}

export const copilotAdapter = {
  provider: "GITHUB_COPILOT",
  requiredScopes: ["read:org"],

  async testAuth(request) {
    await listOrganizations(request, 1);
    return { accountLabel: "Compte GitHub", grantedScopes: null };
  },

  async discover(request) {
    return { scopes: await listOrganizations(request, 10), fetchedAt: new Date() };
  },

  listUsage: (request) => readDays(request, copilotUsageRecords),
} satisfies AiProviderAdapter;
