import { describe, expect, it, vi } from "vitest";
import { ProviderError } from "./adapter";
import type { ProviderProject } from "./domain";
import { DELIVERY_BOUNDS, DELIVERY_QUERY, listGitHubDelivery } from "./github-delivery";

/** Fictitious repositories, logins and identifiers only; no test reaches the network. */
const NOW = new Date("2026-06-30T12:00:00.000Z");
const RECENT = "2026-06-20T10:00:00Z";
const OLD = "2026-01-01T10:00:00Z";

function project(name: string, pushed = RECENT): ProviderProject {
  return { externalId: name, externalUrl: `https://github.example/${name}`, name, visibility: "private", metrics: { lastPushAt: pushed } };
}

function pullRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: "PR_1",
    number: 12,
    title: "Ajoute l'export",
    url: "https://github.example/acme/api/pull/12",
    state: "MERGED",
    isDraft: false,
    createdAt: "2026-06-18T09:00:00Z",
    updatedAt: RECENT,
    closedAt: "2026-06-20T09:30:00Z",
    mergedAt: "2026-06-20T09:30:00Z",
    baseRefName: "main",
    headRefName: "feature/export",
    additions: 120,
    deletions: 8,
    changedFiles: 3,
    author: { login: "dev-a" },
    comments: { totalCount: 4 },
    reviews: {
      totalCount: 2,
      nodes: [
        { id: "R_2", state: "APPROVED", submittedAt: "2026-06-19T16:00:00Z", author: { login: "dev-b" } },
        { id: "R_1", state: "CHANGES_REQUESTED", submittedAt: "2026-06-19T11:00:00Z", author: { login: "dev-b" } },
      ],
    },
    commits: {
      totalCount: 3,
      nodes: [
        { commit: { oid: "a1", committedDate: "2026-06-18T09:00:00Z", author: { user: { login: "dev-a" } } } },
        { commit: { oid: "a2", committedDate: "2026-06-19T12:00:00Z", author: { user: null } } },
      ],
    },
    files: {
      totalCount: 3,
      nodes: [
        { path: "src/export.ts", additions: 100, deletions: 0, changeType: "ADDED" },
        { path: "src/index.ts", additions: 20, deletions: 8, changeType: "MODIFIED" },
        { path: "README.md", additions: 0, deletions: 0, changeType: "MODIFIED" },
      ],
    },
    closingIssuesReferences: {
      totalCount: 1,
      nodes: [{ number: 7, url: "https://github.example/acme/api/issues/7", repository: { nameWithOwner: "acme/api" } }],
    },
    ...overrides,
  };
}

function answer(repository: Record<string, unknown> | null, extra: Record<string, unknown> = {}) {
  return { data: { repository }, ...extra };
}

function repositoryData(overrides: Record<string, unknown> = {}) {
  return {
    pullRequests: { pageInfo: { hasNextPage: false }, nodes: [pullRequest(), pullRequest({ id: "PR_OLD", number: 3, updatedAt: OLD })] },
    releases: {
      nodes: [
        { id: "REL_1", tagName: "v1.2.0", name: "1.2.0", url: "https://github.example/acme/api/releases/v1.2.0", isPrerelease: false, isDraft: false, createdAt: RECENT, publishedAt: RECENT },
        { id: "REL_0", tagName: "v1.0.0", name: "", url: "https://github.example/acme/api/releases/v1.0.0", isPrerelease: false, isDraft: false, createdAt: OLD, publishedAt: OLD },
      ],
    },
    deployments: {
      nodes: [
        { id: "DEP_1", environment: "production", createdAt: RECENT, commitOid: "a2", latestStatus: { state: "SUCCESS", createdAt: "2026-06-20T10:05:00Z" } },
        { id: "DEP_2", environment: "staging", createdAt: RECENT, commitOid: "a1", latestStatus: null },
      ],
    },
    ...overrides,
  };
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });
}

function fakeFetch(byRepository: Record<string, () => Response>) {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const { variables } = JSON.parse(String(init?.body)) as { variables: { owner: string; name: string } };
    const key = `${variables.owner}/${variables.name}`;
    return byRepository[key]();
  });
}

function run(fetchImpl: typeof fetch, projects = [project("acme/api")]) {
  return listGitHubDelivery({ token: "fictitious-token", instanceUrl: "", owner: null, projects, fetchImpl }, NOW);
}

describe("listGitHubDelivery", () => {
  it("normalises pull requests, releases and deployments inside the 90-day window", async () => {
    const fetchImpl = fakeFetch({ "acme/api": () => json(answer(repositoryData())) });
    const outcome = await run(fetchImpl as unknown as typeof fetch);
    const result = outcome.repositories[0];

    expect(outcome).toMatchObject({ supported: true, repositoriesScanned: 1, repositoriesFailed: 0, repositoriesSkipped: 0 });
    expect(outcome.windowStart.toISOString()).toBe("2026-04-01T12:00:00.000Z");
    if (!result.read) throw new Error("expected a read repository");

    expect(result.pullRequests).toHaveLength(1);
    expect(result.pullRequests[0]).toMatchObject({
      externalId: "PR_1",
      repository: "acme/api",
      number: 12,
      authorLogin: "dev-a",
      state: "MERGED",
      commitsCount: 3,
      commentsCount: 4,
      reviewsCount: 2,
      childrenTruncated: true,
      issueLinks: [{ repository: "acme/api", issueNumber: 7, url: "https://github.example/acme/api/issues/7" }],
    });
    expect(result.pullRequests[0].commits[1]).toEqual({ sha: "a2", authorLogin: null, committedAt: new Date("2026-06-19T12:00:00Z") });
    expect(result.pullRequests[0].mergedAt).toEqual(new Date("2026-06-20T09:30:00Z"));
    expect(result.releases.map((release) => release.tagName)).toEqual(["v1.2.0"]);
    expect(result.deployments).toEqual([
      expect.objectContaining({ environment: "production", state: "SUCCESS", sha: "a2" }),
      expect.objectContaining({ environment: "staging", state: null, statusUpdatedAt: null }),
    ]);
    expect(result.windowTruncated).toBe(false);
  });

  it("sends one read-only POST query per repository, bounded, with no text field", async () => {
    const fetchImpl = fakeFetch({ "acme/api": () => json(answer(repositoryData())) });
    await run(fetchImpl as unknown as typeof fetch);

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.github.com/graphql");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer fictitious-token");
    expect(DELIVERY_QUERY).not.toMatch(/mutation|body|bodyText|message|patch|diff/i);
    expect(DELIVERY_QUERY).toContain(`pullRequests(first: ${DELIVERY_BOUNDS.PULL_REQUESTS}`);
    expect(DELIVERY_QUERY).toContain(`files(first: ${DELIVERY_BOUNDS.FILES})`);
  });

  it("an empty repository is read, not failed", async () => {
    const empty = repositoryData({
      pullRequests: { pageInfo: { hasNextPage: false }, nodes: [] },
      releases: { nodes: [] },
      deployments: { nodes: [] },
    });
    const outcome = await run(fakeFetch({ "acme/api": () => json(answer(empty)) }) as unknown as typeof fetch);

    expect(outcome.repositories[0]).toEqual({
      repository: "acme/api",
      read: true,
      pullRequests: [],
      releases: [],
      deployments: [],
      windowTruncated: false,
    });
  });

  it("flags a window cut by the pull request bound", async () => {
    const full = repositoryData({ pullRequests: { pageInfo: { hasNextPage: true }, nodes: [pullRequest()] } });
    const outcome = await run(fakeFetch({ "acme/api": () => json(answer(full)) }) as unknown as typeof fetch);
    expect(outcome.repositories[0]).toMatchObject({ read: true, windowTruncated: true });
  });

  it("stops the run on an HTTP rate limit", async () => {
    const limited = () =>
      new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "0" } });
    await expect(run(fakeFetch({ "acme/api": limited }) as unknown as typeof fetch)).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
  });

  it("stops the run on a GraphQL rate limit", async () => {
    const limited = () => json({ data: null, errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] });
    await expect(run(fakeFetch({ "acme/api": limited }) as unknown as typeof fetch)).rejects.toBeInstanceOf(ProviderError);
  });

  it("records 404, 403 and an unexpected shape per repository and keeps the others (partial)", async () => {
    const projects = [project("acme/api"), project("acme/gone"), project("acme/locked"), project("acme/weird"), project("acme/missing")];
    const fetchImpl = fakeFetch({
      "acme/api": () => json(answer(repositoryData())),
      "acme/gone": () => json(answer(null, { errors: [{ type: "NOT_FOUND", message: "Could not resolve" }] })),
      "acme/locked": () => new Response("{}", { status: 403 }),
      "acme/weird": () => json(answer({ pullRequests: "nope" })),
      "acme/missing": () => new Response("{}", { status: 404 }),
    });
    const outcome = await run(fetchImpl as unknown as typeof fetch, projects);

    expect(outcome).toMatchObject({ repositoriesScanned: 1, repositoriesFailed: 4 });
    expect(outcome.repositories.map((result) => (result.read ? "read" : result.errorCode))).toEqual([
      "read",
      "NOT_FOUND",
      "UNAUTHORIZED (HTTP 403)",
      "INVALID_RESPONSE",
      "NOT_FOUND (HTTP 404)",
    ]);
  });

  it("refuses a pull request without its identifier or a readable date", async () => {
    const broken = repositoryData({
      pullRequests: { pageInfo: { hasNextPage: false }, nodes: [pullRequest({ createdAt: "not a date" })] },
    });
    const outcome = await run(fakeFetch({ "acme/api": () => json(answer(broken)) }) as unknown as typeof fetch);
    expect(outcome.repositories[0]).toMatchObject({ read: false, errorCode: "INVALID_RESPONSE" });
  });

  it("bounds the repositories read and counts the others as skipped", async () => {
    const projects = Array.from({ length: 3 }, (_, index) => project(`acme/r${index}`));
    const fetchImpl = fakeFetch(Object.fromEntries(projects.map((item) => [item.name, () => json(answer(repositoryData()))])));
    const outcome = await listGitHubDelivery(
      { token: "t", instanceUrl: "", owner: null, projects, fetchImpl: fetchImpl as unknown as typeof fetch, maxRepositories: 2 },
      NOW,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(outcome).toMatchObject({ repositoriesScanned: 2, repositoriesSkipped: 1 });
  });
});
