import { describe, expect, it } from "vitest";
import type { AiPageRequest } from "./ai-adapter";
import { describeAiAdapterContract } from "./ai-adapter.contract";
import { copilotAdapter, listCopilotDays, normaliseCopilotDay, readCopilotSeats } from "./copilot";

/**
 * GitHub responses are simulated from the shapes of the public REST reference
 * (Copilot user management, Copilot usage metrics reports). No test reaches GitHub,
 * the token is fictitious and the organization and agents are invented.
 */

const TOKEN = "fake-github-copilot-token";
const ORG = "acme-fixture";
const REPORTS = "https://reports.example.test";
/** A day GitHub has no report for yet. */
const NO_REPORT_DAY = "2026-10-05";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

function dayRecord(day: string) {
  return {
    day,
    organization_id: "1",
    daily_active_users: 4,
    weekly_active_users: 9,
    monthly_active_users: 12,
    monthly_active_agent_users: 3,
    daily_active_copilot_cloud_agent_users: 1,
    user_initiated_interaction_count: 40,
    code_generation_activity_count: 30,
    code_acceptance_activity_count: 10,
    totals_by_3rd_party_agent: [{ agent_id: 42, agent_name: "Agent fictif", user_initiated_interaction_count: 2 }],
    totals_by_client: [
      { client: "vscode", totals_by_model: [{ model: "model-a", request_count: 5, token_usage: { prompt_tokens_sum: 100, output_tokens_sum: 50 } }] },
      { client: "cli", totals_by_model: [{ model: "model-a", request_count: 1, token_usage: { prompt_tokens_sum: 10, output_tokens_sum: 5 } }] },
    ],
  };
}

type Route = (url: URL, init?: RequestInit) => Response | null;

/** Serves the healthy API; `override` answers first when it returns a response. */
function transport(override: Route = () => null, calls: { url: URL; init?: RequestInit }[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    const answered = override(url, init);
    if (answered) return answered;

    if (url.origin === REPORTS) return new Response(`${JSON.stringify(dayRecord(url.pathname.slice(1, 11)))}\n`);
    if (url.pathname === "/user/orgs") return json([{ login: ORG }]);
    if (url.pathname.endsWith("/organization-1-day")) {
      const day = url.searchParams.get("day")!;
      if (day === NO_REPORT_DAY) return json(null, 204);
      return json({ download_links: [`${REPORTS}/${day}.ndjson`], report_day: day });
    }
    if (url.pathname.endsWith("/copilot/billing")) {
      return json({
        seat_breakdown: { total: 150, added_this_cycle: 2, pending_cancellation: 1, pending_invitation: 0, active_this_cycle: 120, inactive_this_cycle: 30 },
        plan_type: "business",
      });
    }
    if (url.pathname.endsWith("/copilot/billing/seats")) {
      const page = Number(url.searchParams.get("page"));
      const size = page === 1 ? 100 : 50;
      return json({ total_seats: 150, seats: Array.from({ length: size }, (_, i) => ({ assignee: { login: `member-${page}-${i}` } })) });
    }
    return json({ message: "Not Found" }, 404);
  }) as typeof fetch;
}

const status = (code: number, headers: Record<string, string> = {}): Route => () => json({ message: "refused" }, code, headers);

describeAiAdapterContract({
  name: "GitHub Copilot",
  adapter: copilotAdapter,
  token: TOKEN,
  instanceUrl: "",
  scopeId: ORG,
  transports: {
    healthy: () => transport(),
    revoked: () => transport(status(401)),
    forbidden: () => transport(status(403)),
    rateLimited: () => transport(status(429, { "retry-after": "30" })),
    // The first page covers 2026-10-01..07: from the 8th on, GitHub refuses.
    rateLimitedAfterFirstPage: () =>
      transport((url) =>
        url.pathname.endsWith("/organization-1-day") && url.searchParams.get("day")! >= "2026-10-08"
          ? json({ message: "slow down" }, 429, { "retry-after": "30" })
          : null,
      ),
    malformed: () => transport((url) => (url.origin === REPORTS ? null : json({ unexpected: true }))),
  },
});

const request = (fetchImpl: typeof fetch, extra: Partial<AiPageRequest> = {}): AiPageRequest => ({
  token: TOKEN,
  instanceUrl: "",
  fetchImpl,
  start: new Date("2026-10-01T00:00:00Z"),
  end: new Date("2026-10-08T00:00:00Z"),
  cursor: null,
  scopeId: ORG,
  ...extra,
});

describe("listCopilotDays", () => {
  it("reads one record per reported day and leaves a day without report absent", async () => {
    const outcome = await listCopilotDays(request(transport()));
    expect(outcome.stoppedBy).toBeNull();
    expect(outcome.records.map((day) => day.day)).toEqual([
      "2026-10-01",
      "2026-10-02",
      "2026-10-03",
      "2026-10-04",
      "2026-10-06",
      "2026-10-07",
    ]);
    expect(outcome.records[0]).toMatchObject({
      externalId: `${ORG}|2026-10-01`,
      dailyActiveUsers: 4,
      monthlyActiveAgentUsers: 3,
      thirdPartyAgents: [{ agentId: "42", agentName: "Agent fictif", interactions: 2 }],
    });
  });

  it("never sends the token to the signed report links", async () => {
    const calls: { url: URL; init?: RequestInit }[] = [];
    await listCopilotDays(request(transport(() => null, calls), { end: new Date("2026-10-02T00:00:00Z") }));
    const downloads = calls.filter((call) => call.url.origin === REPORTS);
    expect(downloads).toHaveLength(1);
    expect(JSON.stringify(downloads[0].init ?? {})).not.toContain(TOKEN);
    const api = calls.find((call) => call.url.origin === "https://api.github.com");
    expect((api?.init?.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("refuses a plain-http report link", async () => {
    const fetchImpl = transport((url) =>
      url.pathname.endsWith("/organization-1-day") ? json({ download_links: ["http://reports.example.test/x"] }) : null,
    );
    await expect(listCopilotDays(request(fetchImpl))).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("reads GitHub's 403 with an empty quota as a rate limit, not a revoked token", async () => {
    const fetchImpl = transport(status(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "0" }));
    await expect(listCopilotDays(request(fetchImpl))).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("needs an organization", async () => {
    await expect(listCopilotDays(request(transport(), { scopeId: undefined }))).rejects.toThrow(RangeError);
  });
});

describe("copilotAdapter.listUsage", () => {
  it("sums one model across clients per day", async () => {
    const outcome = await copilotAdapter.listUsage(request(transport(), { end: new Date("2026-10-02T00:00:00Z") }));
    expect(outcome.records).toEqual([
      {
        externalId: `${ORG}|2026-10-01|model-a`,
        scopeId: ORG,
        model: "model-a",
        periodStart: new Date("2026-10-01T00:00:00Z"),
        periodEnd: new Date("2026-10-02T00:00:00Z"),
        inputTokens: 110,
        outputTokens: 55,
        requests: 6,
      },
    ]);
  });

  it("does not implement costs: Copilot reports no price", () => {
    expect("listCosts" in copilotAdapter).toBe(false);
  });
});

describe("normaliseCopilotDay", () => {
  it("keeps an absent figure unknown rather than zero", () => {
    const day = normaliseCopilotDay(ORG, "2026-10-01", { daily_active_users: 0 });
    expect(day).toMatchObject({ dailyActiveUsers: 0, weeklyActiveUsers: null, interactionCount: null, thirdPartyAgents: [] });
  });

  it("rejects a record without daily active users", () => {
    expect(() => normaliseCopilotDay(ORG, "2026-10-01", {})).toThrow(/utilisateurs actifs/);
  });
});

describe("readCopilotSeats", () => {
  it("returns the breakdown and a count of the list, never a login", async () => {
    const seats = await readCopilotSeats({ token: TOKEN, instanceUrl: "", fetchImpl: transport(), scopeId: ORG });
    expect(seats).toEqual({
      organization: ORG,
      planType: "business",
      total: 150,
      activeThisCycle: 120,
      inactiveThisCycle: 30,
      addedThisCycle: 2,
      pendingInvitation: 0,
      pendingCancellation: 1,
      listedSeats: 150,
    });
    expect(JSON.stringify(seats)).not.toContain("member-");
  });

  it("reports a token without owner rights as FORBIDDEN", async () => {
    await expect(
      readCopilotSeats({ token: TOKEN, instanceUrl: "", fetchImpl: transport(status(403)), scopeId: ORG }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
