import {
  parseProviderInstant,
  ProviderError,
  type DeliveryRepositoryResult,
  type DeliverySyncOutcome,
  type IssueSyncRequest,
} from "./adapter";
import type { ProviderDeployment, ProviderPullRequest, ProviderRelease } from "./domain";
import { classifyGitHubError, DEFAULT_MAX_REPOSITORIES, selectRepositoriesToScan } from "./github";
import { DELIVERY_QUERY, GRAPHQL_URL } from "./github-delivery.query";

/**
 * GitHub delivery history (M14-02), read through the GraphQL API.
 *
 * REST would need one request per pull request for its files, reviews and commits; one
 * GraphQL query per repository returns them all, within fixed bounds. The token stays
 * read-only: GraphQL `query` operations cannot write, and no mutation is ever sent.
 *
 * Bounds, per repository and per run: the `PULL_REQUESTS` most recently updated pull
 * requests (only those updated inside the window are kept), and per pull request at
 * most `FILES` files, `REVIEWS` reviews, `COMMITS` commits and `LINKS` closing issue
 * references. A cut list sets `childrenTruncated`; the provider's own counters
 * (`changedFiles`, `commitsCount`, `reviewsCount`) stay exact. Releases and deployments:
 * the `RELEASES` / `DEPLOYMENTS` most recent, created inside the window.
 *
 * Never read: pull request descriptions, comment or review text, commit messages, diffs.
 *
 * Errors: an HTTP refusal or a GraphQL error on one repository is recorded for that
 * repository with its safe code (`NOT_FOUND`, `UNAUTHORIZED`, `INVALID_RESPONSE`...).
 * A spent quota — HTTP or GraphQL `RATE_LIMITED` — stops the run, since every
 * following request would fail the same way.
 */

export const DELIVERY_WINDOW_DAYS = 90;

type Json = Record<string, unknown>;

function invalid(what: string): ProviderError {
  return new ProviderError("INVALID_RESPONSE", `Réponse GitHub inattendue (${what}).`);
}

function object(value: unknown, what: string): Json {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid(what);
  return value as Json;
}

function nodes(connection: unknown, what: string): unknown[] {
  const list = object(connection, what).nodes;
  if (!Array.isArray(list)) throw invalid(what);
  return list;
}

function total(connection: unknown, what: string): number {
  const count = object(connection, what).totalCount;
  if (typeof count !== "number" || count < 0) throw invalid(what);
  return count;
}

function text(value: unknown, what: string): string {
  if (typeof value !== "string" || value.length === 0) throw invalid(what);
  return value;
}

function count(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw invalid(what);
  return value;
}

function login(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const name = (value as Json).login;
  return typeof name === "string" && name.length > 0 ? name : null;
}

function instant(value: unknown): Date {
  return parseProviderInstant(value, "GITHUB");
}

function optionalInstant(value: unknown): Date | null {
  return value === null || value === undefined ? null : instant(value);
}

export function normaliseGitHubPullRequest(raw: unknown, repository: string): ProviderPullRequest {
  const pr = object(raw, "pull request");
  const reviews = nodes(pr.reviews, "reviews");
  const commits = nodes(pr.commits, "commits");
  const files = nodes(pr.files, "files");
  const links = nodes(pr.closingIssuesReferences, "closing issues");
  const reviewsCount = total(pr.reviews, "reviews");
  const commitsCount = total(pr.commits, "commits");
  const filesCount = total(pr.files, "files");
  const linksCount = total(pr.closingIssuesReferences, "closing issues");

  return {
    externalId: text(pr.id, "pull request id"),
    repository,
    number: count(pr.number, "pull request number"),
    title: text(pr.title, "pull request title"),
    url: text(pr.url, "pull request url"),
    authorLogin: login(pr.author),
    state: text(pr.state, "pull request state"),
    isDraft: pr.isDraft === true,
    baseBranch: text(pr.baseRefName, "base branch"),
    headBranch: text(pr.headRefName, "head branch"),
    additions: count(pr.additions, "additions"),
    deletions: count(pr.deletions, "deletions"),
    changedFiles: count(pr.changedFiles, "changed files"),
    commitsCount,
    commentsCount: total(pr.comments, "comments"),
    reviewsCount,
    openedAt: instant(pr.createdAt),
    closedAt: optionalInstant(pr.closedAt),
    mergedAt: optionalInstant(pr.mergedAt),
    updatedAt: instant(pr.updatedAt),
    childrenTruncated:
      reviews.length < reviewsCount ||
      commits.length < commitsCount ||
      files.length < filesCount ||
      links.length < linksCount,
    files: files.map((item) => {
      const file = object(item, "file");
      return {
        path: text(file.path, "file path"),
        additions: count(file.additions, "file additions"),
        deletions: count(file.deletions, "file deletions"),
        changeType: text(file.changeType, "file change type"),
      };
    }),
    reviews: reviews.map((item) => {
      const review = object(item, "review");
      return {
        externalId: text(review.id, "review id"),
        authorLogin: login(review.author),
        state: text(review.state, "review state"),
        submittedAt: optionalInstant(review.submittedAt),
      };
    }),
    commits: commits.map((item) => {
      const commit = object(object(item, "commit").commit, "commit");
      const author = typeof commit.author === "object" && commit.author !== null ? (commit.author as Json).user : null;
      return {
        sha: text(commit.oid, "commit oid"),
        authorLogin: login(author),
        committedAt: instant(commit.committedDate),
      };
    }),
    issueLinks: links.map((item) => {
      const issue = object(item, "closing issue");
      return {
        repository: text(object(issue.repository, "issue repository").nameWithOwner, "issue repository"),
        issueNumber: count(issue.number, "issue number"),
        url: text(issue.url, "issue url"),
      };
    }),
  };
}

export function normaliseGitHubRelease(raw: unknown, repository: string): ProviderRelease {
  const release = object(raw, "release");
  return {
    externalId: text(release.id, "release id"),
    repository,
    tagName: text(release.tagName, "release tag"),
    name: typeof release.name === "string" && release.name.length > 0 ? release.name : null,
    url: text(release.url, "release url"),
    isPrerelease: release.isPrerelease === true,
    isDraft: release.isDraft === true,
    releasedAt: instant(release.createdAt),
    publishedAt: optionalInstant(release.publishedAt),
  };
}

export function normaliseGitHubDeployment(raw: unknown, repository: string): ProviderDeployment {
  const deployment = object(raw, "deployment");
  const status =
    deployment.latestStatus === null || deployment.latestStatus === undefined
      ? null
      : object(deployment.latestStatus, "deployment status");
  return {
    externalId: text(deployment.id, "deployment id"),
    repository,
    environment: text(deployment.environment, "deployment environment"),
    sha: text(deployment.commitOid, "deployment commit"),
    state: status ? text(status.state, "deployment state") : null,
    deployedAt: instant(deployment.createdAt),
    statusUpdatedAt: status ? optionalInstant(status.createdAt) : null,
  };
}

/** Maps GraphQL `errors` to the adapter's safe codes; `null` when there is none. */
export function graphQLError(body: Json): ProviderError | null {
  const errors = body.errors;
  if (!Array.isArray(errors) || errors.length === 0) return null;

  const types = errors.map((error) =>
    typeof error === "object" && error !== null ? String((error as Json).type ?? "") : "",
  );

  if (types.includes("RATE_LIMITED")) return new ProviderError("RATE_LIMITED", "Quota GitHub atteint.");
  if (types.includes("NOT_FOUND")) return new ProviderError("NOT_FOUND", "Dépôt GitHub introuvable.");
  if (types.some((type) => type === "FORBIDDEN" || type === "INSUFFICIENT_SCOPES")) {
    return new ProviderError("UNAUTHORIZED", "Permissions GitHub insuffisantes pour ce dépôt.");
  }
  return new ProviderError("HTTP_ERROR", "Erreur GraphQL GitHub.");
}

/** Parses one repository answer and keeps what falls inside the window. */
export function readDeliveryAnswer(
  body: unknown,
  repository: string,
  windowStart: Date,
): Extract<DeliveryRepositoryResult, { read: true }> {
  const root = object(body, "body");
  const error = graphQLError(root);
  if (error) throw error;

  const repo = object(object(root.data, "data").repository, "repository");
  const prConnection = object(repo.pullRequests, "pull requests");
  const pullRequests = nodes(prConnection, "pull requests").map((raw) => normaliseGitHubPullRequest(raw, repository));
  const inWindow = pullRequests.filter((pr) => pr.updatedAt >= windowStart);
  const hasNextPage = object(prConnection.pageInfo, "page info").hasNextPage === true;

  return {
    repository,
    read: true,
    pullRequests: inWindow,
    // Every node read is still inside the window and more exist: the bound cut it.
    windowTruncated: hasNextPage && inWindow.length === pullRequests.length,
    releases: nodes(repo.releases, "releases")
      .map((raw) => normaliseGitHubRelease(raw, repository))
      .filter((release) => release.releasedAt >= windowStart),
    deployments: nodes(repo.deployments, "deployments")
      .map((raw) => normaliseGitHubDeployment(raw, repository))
      .filter((deployment) => deployment.deployedAt >= windowStart),
  };
}

async function postQuery(
  request: IssueSyncRequest,
  repository: string,
): Promise<unknown> {
  const fetchImpl = request.fetchImpl ?? fetch;
  const [owner, ...rest] = repository.split("/");
  const name = rest.join("/");

  if (!owner || !name) throw invalid("repository name");

  let response: Response;
  try {
    response = await fetchImpl(GRAPHQL_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${request.token}`,
      },
      body: JSON.stringify({ query: DELIVERY_QUERY, variables: { owner, name } }),
      signal: request.signal,
      cache: "no-store",
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new ProviderError("NETWORK", "Synchronisation annulée.");
    }
    throw new ProviderError("NETWORK", "GitHub est injoignable.");
  }

  if (!response.ok) throw classifyGitHubError(response);

  try {
    return await response.json();
  } catch {
    throw new ProviderError("INVALID_RESPONSE", "Réponse illisible de GitHub.", { status: response.status });
  }
}

export async function listGitHubDelivery(
  request: IssueSyncRequest,
  now: Date = new Date(),
): Promise<DeliverySyncOutcome> {
  const windowStart = new Date(now.getTime() - DELIVERY_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const { repositories, skipped } = selectRepositoriesToScan(
    request.projects,
    request.maxRepositories ?? DEFAULT_MAX_REPOSITORIES,
  );
  const results: DeliveryRepositoryResult[] = [];

  for (const repository of repositories) {
    try {
      results.push(readDeliveryAnswer(await postQuery(request, repository), repository, windowStart));
    } catch (error) {
      if (!(error instanceof ProviderError) || error.code === "RATE_LIMITED") throw error;
      results.push({ repository, read: false, errorCode: error.toSafeMessage() });
    }
  }

  return {
    supported: true,
    repositories: results,
    windowStart,
    fetchedAt: now,
    repositoriesScanned: results.filter((result) => result.read).length,
    repositoriesSkipped: skipped,
    repositoriesFailed: results.filter((result) => !result.read).length,
  };
}
