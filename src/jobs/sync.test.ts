import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderError, type IntegrationAdapter } from "@/modules/integrations/adapter";

const findConnectionForSyncMock = vi.fn();
const listConnectionsMock = vi.fn();
const startSyncRunMock = vi.fn();
const finishSyncRunMock = vi.fn();
const markSyncSuccessMock = vi.fn();
const markSyncFailureMock = vi.fn();
const saveSnapshotsMock = vi.fn();
const saveIssuesMock = vi.fn();
const saveMilestonesMock = vi.fn();
const listProjectsMock = vi.fn();
const listIssuesMock = vi.fn();
const listMilestonesMock = vi.fn();
const listCacheEntriesMock = vi.fn();
const saveCacheChecksMock = vi.fn();
const saveCiRunsMock = vi.fn();
const listCiRunsMock = vi.fn();
const recordAuditEventSafelyMock = vi.fn();

vi.mock("@/modules/audit/repository", () => ({
  recordAuditEventSafely: (...args: unknown[]) => recordAuditEventSafelyMock(...args),
}));

vi.mock("@/modules/integrations/repository", () => ({
  findConnectionForSync: (...args: unknown[]) => findConnectionForSyncMock(...args),
  listConnections: (...args: unknown[]) => listConnectionsMock(...args),
  startSyncRun: (...args: unknown[]) => startSyncRunMock(...args),
  finishSyncRun: (...args: unknown[]) => finishSyncRunMock(...args),
  markSyncSuccess: (...args: unknown[]) => markSyncSuccessMock(...args),
  markSyncFailure: (...args: unknown[]) => markSyncFailureMock(...args),
  saveSnapshots: (...args: unknown[]) => saveSnapshotsMock(...args),
  saveIssues: (...args: unknown[]) => saveIssuesMock(...args),
  saveMilestones: (...args: unknown[]) => saveMilestonesMock(...args),
  listCacheEntries: (...args: unknown[]) => listCacheEntriesMock(...args),
  saveCacheChecks: (...args: unknown[]) => saveCacheChecksMock(...args),
  saveCiRuns: (...args: unknown[]) => saveCiRunsMock(...args),
}));

vi.mock("@/modules/integrations/github", () => ({
  createGitHubAdapter: (): IntegrationAdapter => ({
    provider: "GITHUB",
    requiredScopes: [],
    tracksIssues: true,
    tracksMilestones: true,
    listProjects: (...args: unknown[]) => listProjectsMock(...args),
    listIssues: (...args: unknown[]) => listIssuesMock(...args),
    listMilestones: (...args: unknown[]) => listMilestonesMock(...args),
    listCiRuns: (...args: unknown[]) => listCiRunsMock(...args),
  }),
}));

vi.mock("@/modules/integrations/gitlab", () => ({
  createGitLabAdapter: (): IntegrationAdapter => ({
    provider: "GITLAB",
    requiredScopes: [],
    tracksIssues: false,
    tracksMilestones: false,
    listProjects: (...args: unknown[]) => listProjectsMock(...args),
    listIssues: (...args: unknown[]) => listIssuesMock(...args),
    listMilestones: (...args: unknown[]) => listMilestonesMock(...args),
    listCiRuns: (...args: unknown[]) => listCiRunsMock(...args),
  }),
}));

const { synchroniseConnection } = await import("./sync");

/**
 * Fictitious identifiers only. The run lifecycle is tested against mocked
 * repository and adapter modules: no test touches a database or the network.
 */
const CONNECTION = {
  id: "connection-1",
  userId: "owner-1",
  provider: "GITHUB" as const,
  instanceUrl: "",
  externalOwner: null,
  token: "ghp_fictitious_token",
};

const FETCHED_AT = new Date(Date.UTC(2026, 9, 5, 10, 0, 0));
const PROJECT_OUTCOME = {
  projects: [
    { externalId: "p1", externalUrl: "https://example.test/p1", name: "owner/one", visibility: null, metrics: {} },
    { externalId: "p2", externalUrl: "https://example.test/p2", name: "owner/two", visibility: null, metrics: {} },
  ],
  fetchedAt: FETCHED_AT,
};
/** Both repositories read in full: a 200 each, with a fictitious validator. */
const fullCheck = (kind: string, repository: string) => ({
  resource: `v1 https://api.example.test/repos/${repository}/${kind}`,
  repository,
  notModified: false,
  validator: { etag: `"${kind}-${repository}"`, lastModified: null },
});
const ISSUE_OUTCOME = {
  supported: true,
  issues: [{ externalId: "issue-1" }],
  checks: [fullCheck("issues", "owner/one"), fullCheck("issues", "owner/two")],
  fetchedAt: FETCHED_AT,
  repositoriesScanned: 2,
  repositoriesSkipped: 0,
  repositoriesFailed: 0,
};
const MILESTONE_OUTCOME = {
  supported: true,
  milestones: [],
  checks: [fullCheck("milestones", "owner/one"), fullCheck("milestones", "owner/two")],
  fetchedAt: FETCHED_AT,
  repositoriesScanned: 2,
  repositoriesSkipped: 0,
  repositoriesFailed: 0,
};

const CI_OUTCOME = {
  supported: true,
  repositories: [
    { repository: "owner/one", read: true, runs: [] },
    { repository: "owner/two", read: true, runs: [] },
  ],
  fetchedAt: FETCHED_AT,
  repositoriesScanned: 2,
  repositoriesSkipped: 0,
  repositoriesFailed: 0,
};

describe("synchroniseConnection run history", () => {
  beforeEach(() => {
    findConnectionForSyncMock.mockReset().mockResolvedValue(CONNECTION);
    startSyncRunMock.mockReset().mockResolvedValue("run-1");
    finishSyncRunMock.mockReset().mockResolvedValue(undefined);
    markSyncSuccessMock.mockReset().mockResolvedValue(undefined);
    markSyncFailureMock.mockReset().mockResolvedValue(undefined);
    saveSnapshotsMock.mockReset().mockResolvedValue({ created: 1, updated: 1 });
    saveIssuesMock.mockReset().mockResolvedValue({ created: 0, updated: 1 });
    saveMilestonesMock.mockReset().mockResolvedValue({ created: 1, updated: 0 });
    listProjectsMock.mockReset().mockResolvedValue(PROJECT_OUTCOME);
    listIssuesMock.mockReset().mockResolvedValue(ISSUE_OUTCOME);
    listMilestonesMock.mockReset().mockResolvedValue(MILESTONE_OUTCOME);
    listCacheEntriesMock.mockReset().mockResolvedValue([]);
    saveCacheChecksMock.mockReset().mockResolvedValue(undefined);
    listCiRunsMock.mockReset().mockResolvedValue(CI_OUTCOME);
    saveCiRunsMock.mockReset().mockResolvedValue({ created: 0, updated: 0 });
    recordAuditEventSafelyMock.mockReset().mockResolvedValue(undefined);
  });

  it("records a successful run with its counters", async () => {
    const result = await synchroniseConnection("owner-1", "connection-1");

    expect(result).toMatchObject({
      status: "SYNCHRONISED",
      projectCount: 2,
      issueCount: 1,
      milestoneCount: 0,
      retries: 0,
    });
    expect(startSyncRunMock).toHaveBeenCalledWith("connection-1");
    expect(finishSyncRunMock).toHaveBeenCalledWith("run-1", {
      status: "SUCCESS",
      // 2 projects + 1 issue + 0 milestones read; 1 + 0 + 1 created; 1 + 1 + 0 updated.
      fetched: 3,
      created: 2,
      updated: 2,
      skipped: 0,
      failed: 0,
      retries: 0,
    });
    expect(markSyncSuccessMock).toHaveBeenCalledWith("connection-1", FETCHED_AT);

    const [audit] = recordAuditEventSafelyMock.mock.calls[0] as [Record<string, unknown>];
    expect(audit).toMatchObject({
      workspaceId: "owner-1",
      actorId: null,
      action: "integration.sync",
      entityType: "INTEGRATION",
      entityId: "connection-1",
      outcome: "SUCCESS",
      metadata: { provider: "GITHUB", status: "SUCCESS", fetched: 3, retries: 0 },
    });
    expect(JSON.stringify(audit)).not.toContain(CONNECTION.token);
  });

  it("closes the run as partial when repositories were left unread", async () => {
    listIssuesMock.mockResolvedValue({
      ...ISSUE_OUTCOME,
      repositoriesScanned: 1,
      repositoriesSkipped: 1,
    });

    const result = await synchroniseConnection("owner-1", "connection-1");

    expect(result).toMatchObject({ status: "SYNCHRONISED", issuesSkippedRepositories: 1 });
    expect(finishSyncRunMock).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({ status: "PARTIAL", skipped: 1 }),
    );
    // A partial read is still a successful synchronisation for the freshness display.
    expect(markSyncSuccessMock).toHaveBeenCalled();
  });

  it("counts a repository failure reported by the milestone scan", async () => {
    listMilestonesMock.mockResolvedValue({
      ...MILESTONE_OUTCOME,
      repositoriesScanned: 1,
      repositoriesFailed: 1,
    });

    await synchroniseConnection("owner-1", "connection-1");

    expect(finishSyncRunMock).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({ status: "PARTIAL", failed: 1 }),
    );
  });

  it("sends only the validators that are neither expired nor malformed", async () => {
    const now = Date.now();
    listCacheEntriesMock.mockResolvedValue([
      {
        resource: "v1 fresh",
        etag: '"fresh"',
        lastModified: null,
        checkedAt: new Date(now),
        changedAt: new Date(now - 60 * 60 * 1000),
      },
      {
        resource: "v1 expired",
        etag: '"expired"',
        lastModified: null,
        checkedAt: new Date(now),
        changedAt: new Date(now - 30 * 24 * 60 * 60 * 1000),
      },
      {
        resource: "v1 malformed",
        etag: "not-quoted",
        lastModified: "not a date",
        checkedAt: new Date(now),
        changedAt: new Date(now),
      },
    ]);

    await synchroniseConnection("owner-1", "connection-1");

    const cache = listIssuesMock.mock.calls[0][0].cache as Map<string, unknown>;
    expect([...cache.keys()]).toEqual(["v1 fresh"]);
    expect(listMilestonesMock.mock.calls[0][0].cache).toBe(cache);
  });

  it("prunes only the repositories read in full, never one answered 304", async () => {
    listIssuesMock.mockResolvedValue({
      ...ISSUE_OUTCOME,
      checks: [
        fullCheck("issues", "owner/one"),
        { ...fullCheck("issues", "owner/two"), notModified: true, validator: null },
      ],
    });

    await synchroniseConnection("owner-1", "connection-1");

    expect(saveIssuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        readRepositories: ["owner/one"],
        trackedRepositories: ["owner/one", "owner/two"],
      }),
    );
  });

  it("stores the validators only after the rows they vouch for", async () => {
    const order: string[] = [];
    saveIssuesMock.mockImplementation(async () => {
      order.push("issues");
      return { created: 0, updated: 1 };
    });
    saveCacheChecksMock.mockImplementation(async (input: { kind: string }) => {
      order.push(`cache:${input.kind}`);
    });
    saveMilestonesMock.mockImplementation(async () => {
      order.push("milestones");
      return { created: 1, updated: 0 };
    });

    await synchroniseConnection("owner-1", "connection-1");

    expect(order).toEqual(["issues", "cache:issues", "milestones", "cache:milestones"]);
  });

  it("stores no validator when the rows could not be saved", async () => {
    saveIssuesMock.mockRejectedValue(new Error("database unavailable"));

    const result = await synchroniseConnection("owner-1", "connection-1");

    expect(result).toMatchObject({ status: "FAILED" });
    expect(saveCacheChecksMock).not.toHaveBeenCalled();
  });

  it("touches neither rows nor validators for a provider whose issues are not read", async () => {
    listIssuesMock.mockResolvedValue({ ...ISSUE_OUTCOME, supported: false, issues: [], checks: [] });
    listMilestonesMock.mockResolvedValue({
      ...MILESTONE_OUTCOME,
      supported: false,
      checks: [],
    });

    await synchroniseConnection("owner-1", "connection-1");

    expect(saveIssuesMock).not.toHaveBeenCalled();
    expect(saveMilestonesMock).not.toHaveBeenCalled();
    expect(saveCacheChecksMock).not.toHaveBeenCalled();
  });

  it("stores CI runs and counts them in the run history", async () => {
    listCiRunsMock.mockResolvedValue({
      ...CI_OUTCOME,
      repositories: [
        { repository: "owner/one", read: true, runs: [{ externalId: "run-1" }, { externalId: "run-2" }] },
        { repository: "owner/two", read: true, runs: [] },
      ],
    });
    saveCiRunsMock.mockResolvedValue({ created: 2, updated: 0 });

    await synchroniseConnection("owner-1", "connection-1");

    expect(saveCiRunsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "connection-1",
        trackedRepositories: ["owner/one", "owner/two"],
      }),
    );
    expect(finishSyncRunMock).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({ status: "SUCCESS", fetched: 5, created: 4 }),
    );
  });

  it("keeps the run successful when a repository's CI is refused", async () => {
    listCiRunsMock.mockResolvedValue({
      ...CI_OUTCOME,
      repositories: [
        { repository: "owner/one", read: false, errorCode: "UNAUTHORIZED (HTTP 403)" },
        { repository: "owner/two", read: true, runs: [] },
      ],
      repositoriesScanned: 1,
      repositoriesFailed: 1,
    });

    const result = await synchroniseConnection("owner-1", "connection-1");

    expect(result).toMatchObject({ status: "SYNCHRONISED" });
    expect(finishSyncRunMock).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({ status: "SUCCESS", failed: 0 }),
    );
  });

  it("does not touch CI storage for a provider whose CI is not read", async () => {
    listCiRunsMock.mockResolvedValue({ ...CI_OUTCOME, supported: false, repositories: [] });

    await synchroniseConnection("owner-1", "connection-1");

    expect(saveCiRunsMock).not.toHaveBeenCalled();
  });

  it("fails the run when the CI read hits the rate limit", async () => {
    listCiRunsMock.mockRejectedValue(
      new ProviderError("RATE_LIMITED", "Quota GitHub atteint.", { status: 403 }),
    );

    const result = await synchroniseConnection("owner-1", "connection-1");

    expect(result).toMatchObject({ status: "FAILED", code: "RATE_LIMITED (HTTP 403)" });
    expect(markSyncSuccessMock).not.toHaveBeenCalled();
  });

  it("records a failed run and persists only the safe message", async () => {
    listProjectsMock.mockRejectedValue(
      new ProviderError("HTTP_ERROR", "boom ghp_fictitious_token", { status: 502 }),
    );

    const result = await synchroniseConnection("owner-1", "connection-1");

    expect(result).toEqual({
      connectionId: "connection-1",
      provider: "GITHUB",
      status: "FAILED",
      code: "HTTP_ERROR (HTTP 502)",
    });
    expect(markSyncFailureMock).toHaveBeenCalledWith("connection-1", "HTTP_ERROR (HTTP 502)");
    expect(finishSyncRunMock).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({ status: "FAILED", errorSummary: "HTTP_ERROR (HTTP 502)" }),
    );
    // Nothing persisted may quote the provider message or the token.
    const persisted = JSON.stringify(finishSyncRunMock.mock.calls);
    expect(persisted).not.toContain("ghp_fictitious_token");
    expect(persisted).not.toContain("boom");

    const [audit] = recordAuditEventSafelyMock.mock.calls[0] as [Record<string, unknown>];
    expect(audit).toMatchObject({
      action: "integration.sync",
      entityId: "connection-1",
      outcome: "FAILED",
      metadata: { provider: "GITHUB", code: "HTTP_ERROR" },
    });
    // The safe code is the whole message: neither the provider text nor the token.
    expect(JSON.stringify(audit)).not.toContain("ghp_fictitious_token");
    expect(JSON.stringify(audit)).not.toContain("boom");
  });

  it("retries transient failures and reports the retry count", async () => {
    // The stub adapter goes through the wrapped fetch, like the real adapters do.
    listProjectsMock.mockImplementationOnce(
      async (request: { fetchImpl: typeof fetch }) => {
        await request.fetchImpl("https://api.example.test/repos");
        return PROJECT_OUTCOME;
      },
    );
    const respondingFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));

    const result = await synchroniseConnection("owner-1", "connection-1", {
      fetchImpl: respondingFetch as unknown as typeof fetch,
      sleep: async () => {},
      random: () => 0.5,
    });

    expect(respondingFetch).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ status: "SYNCHRONISED", retries: 1 });
    expect(finishSyncRunMock).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({ retries: 1 }),
    );
  });

  it("does not open a run when the connection is missing", async () => {
    findConnectionForSyncMock.mockResolvedValue(null);

    const result = await synchroniseConnection("owner-1", "gone");

    expect(result).toEqual({
      connectionId: "gone",
      provider: "GITHUB",
      status: "SKIPPED",
      reason: "NOT_FOUND",
    });
    expect(startSyncRunMock).not.toHaveBeenCalled();
  });

  it("does not open a run when the stored token cannot be read", async () => {
    findConnectionForSyncMock.mockResolvedValue({ ...CONNECTION, token: null });

    const result = await synchroniseConnection("owner-1", "connection-1");

    expect(result).toMatchObject({ status: "SKIPPED", reason: "NO_TOKEN" });
    expect(startSyncRunMock).not.toHaveBeenCalled();
  });
});
