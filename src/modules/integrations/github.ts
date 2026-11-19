import {
  assertIssueShape,
  assertMilestoneShape,
  assertProjectShape,
  descriptionPresence,
  parseProviderInstant,
  parseRetryAfterSeconds,
  ProviderError,
  requestJson,
  requestJsonConditional,
  type CiRepositoryResult,
  type CiSyncOutcome,
  type IntegrationAdapter,
  type IssueSyncOutcome,
  type IssueSyncRequest,
  type MilestoneSyncOutcome,
  type ResourceCheck,
  type SyncRequest,
} from "./adapter";
import { cacheResourceKey } from "./cache";
import { listGitHubDelivery } from "./github-delivery";
import type {
  ProviderCiRun,
  ProviderIssue,
  ProviderMilestone,
  ProviderProject,
  SyncOutcome,
} from "./domain";

/**
 * GitHub adapter (read-only).
 *
 * The token needs `repo` (or a fine-grained read-only equivalent) to see private
 * repositories the owner is allowed to read. Only normalised metadata is kept:
 * no file content, no commit content, no issue description, no comment body.
 */
const API_BASE = "https://api.github.com";
const API_VERSION = "2022-11-28";
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 5;
/** Issues are queried per repository, so the run is bounded. */
export const DEFAULT_MAX_REPOSITORIES = 20;
const DEFAULT_ISSUE_PAGE_SIZE = 50;
const DEFAULT_MILESTONE_PAGE_SIZE = 50;
/** Recent workflow runs read per repository: enough to find each workflow's latest. */
const DEFAULT_CI_PAGE_SIZE = 20;
const MAX_LABELS = 5;
const MAX_ASSIGNEES = 5;

type GitHubRepository = {
  id?: unknown;
  full_name?: unknown;
  html_url?: unknown;
  private?: unknown;
  default_branch?: unknown;
  language?: unknown;
  stargazers_count?: unknown;
  open_issues_count?: unknown;
  pushed_at?: unknown;
  description?: unknown;
  topics?: unknown;
};

/**
 * Shape of the issues endpoint, which returns **issues and pull requests together**.
 * The `pull_request` key is what separates them, and it is why this adapter never
 * trusts a repository's `open_issues_count` for a count of issues: that number
 * includes pull requests on GitHub.
 */
type GitHubIssue = {
  id?: unknown;
  number?: unknown;
  title?: unknown;
  html_url?: unknown;
  comments?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  labels?: unknown;
  user?: unknown;
  pull_request?: unknown;
  assignees?: unknown;
  milestone?: unknown;
};

/** Shape of the milestones endpoint. */
type GitHubMilestone = {
  id?: unknown;
  number?: unknown;
  title?: unknown;
  state?: unknown;
  due_on?: unknown;
  open_issues?: unknown;
  closed_issues?: unknown;
  html_url?: unknown;
};

/** Shape of one entry of the workflow runs endpoint (`workflow_runs`). */
type GitHubWorkflowRun = {
  id?: unknown;
  name?: unknown;
  head_branch?: unknown;
  status?: unknown;
  conclusion?: unknown;
  html_url?: unknown;
  run_started_at?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
};

/** Reads the `rel="next"` link returned by GitHub; `null` means the last page. */
export function nextPageUrl(linkHeader: string | null): string | null {
  if (!linkHeader) {
    return null;
  }

  for (const part of linkHeader.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="([^"]+)"/.exec(part.trim());
    if (match && match[2] === "next") {
      return match[1];
    }
  }

  return null;
}

export function classifyGitHubError(response: Response): ProviderError {
  const status = response.status;

  if (status === 403 && response.headers.get("x-ratelimit-remaining") === "0") {
    const reset = Number(response.headers.get("x-ratelimit-reset"));
    const retryAfterSeconds = Number.isFinite(reset)
      ? Math.max(0, reset - Math.floor(Date.now() / 1000))
      : undefined;

    return new ProviderError("RATE_LIMITED", "Quota GitHub atteint.", {
      status,
      retryAfterSeconds,
    });
  }

  if (status === 401 || status === 403) {
    return new ProviderError(
      "UNAUTHORIZED",
      "Jeton GitHub refusé ou permissions insuffisantes.",
      { status },
    );
  }

  if (status === 404) {
    return new ProviderError("NOT_FOUND", "Organisation GitHub introuvable.", {
      status,
    });
  }

  if (status === 429) {
    return new ProviderError("RATE_LIMITED", "Quota GitHub atteint.", {
      status,
      retryAfterSeconds: parseRetryAfterSeconds(response),
    });
  }

  return new ProviderError("HTTP_ERROR", "Erreur GitHub.", { status });
}

export function normaliseGitHubRepository(
  repository: GitHubRepository,
): ProviderProject {
  const project: ProviderProject = {
    externalId: String(repository.id ?? ""),
    externalUrl: typeof repository.html_url === "string" ? repository.html_url : "",
    name: typeof repository.full_name === "string" ? repository.full_name : "",
    visibility: repository.private === true ? "private" : "public",
    metrics: {
      defaultBranch: repository.default_branch ?? null,
      language: repository.language ?? null,
      stars: typeof repository.stargazers_count === "number" ? repository.stargazers_count : null,
      openIssues:
        typeof repository.open_issues_count === "number" ? repository.open_issues_count : null,
      lastPushAt: repository.pushed_at ?? null,
      // Repository hygiene (DA-05): presence only, never the text itself.
      hasDescription: descriptionPresence(repository.description),
      topicCount: Array.isArray(repository.topics) ? repository.topics.length : null,
    },
  };

  assertProjectShape(project, "GITHUB");
  return project;
}

export function createGitHubAdapter(): IntegrationAdapter {
  return {
    provider: "GITHUB",
    requiredScopes: ["repo:read", "actions:read", "deployments:read"],
    tracksIssues: true,
    tracksMilestones: true,

    async listProjects(request: SyncRequest): Promise<SyncOutcome> {
      const fetchImpl = request.fetchImpl ?? fetch;
      const pageSize = request.pageSize ?? DEFAULT_PAGE_SIZE;
      const maxPages = request.maxPages ?? DEFAULT_MAX_PAGES;
      const headers: Record<string, string> = {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${request.token}`,
        "X-GitHub-Api-Version": API_VERSION,
      };

      // GitHub has no "all repositories" endpoint: an organisation is listed
      // through /orgs, the owner's own access through /user/repos.
      const firstPage = request.owner
        ? `${API_BASE}/orgs/${encodeURIComponent(request.owner)}/repos?per_page=${pageSize}&type=all&sort=updated`
        : `${API_BASE}/user/repos?per_page=${pageSize}&affiliation=owner,collaborator,organization_member&sort=updated`;

      const projects: ProviderProject[] = [];
      let url: string | null = firstPage;
      let pages = 0;

      while (url && pages < maxPages) {
        const { data, response }: { data: unknown; response: Response } =
          await requestJson<unknown>({
            url,
            headers,
            fetchImpl,
            signal: request.signal,
            classifyError: classifyGitHubError,
          });

        if (!Array.isArray(data)) {
          throw new ProviderError(
            "INVALID_RESPONSE",
            "GitHub n'a pas renvoyé une liste de dépôts.",
            { status: response.status },
          );
        }

        for (const repository of data as GitHubRepository[]) {
          projects.push(normaliseGitHubRepository(repository));
        }

        pages += 1;
        // Pagination continues only while the provider announces another page:
        // partial synchronisation is preferable to a truncated silent one.
        url = pages < maxPages ? nextPageUrl(response.headers.get("link")) : null;
      }

      return { projects, fetchedAt: new Date() };
    },

    /**
     * Open issues and pull requests, one request per repository.
     *
     * Only the repositories that moved most recently are queried, so a run stays
     * short and a large organisation does not consume a whole rate-limit window on
     * repositories nobody touched for a year. What was left out is reported in
     * `repositoriesSkipped`: the interface says "not read", never "nothing open".
     */
    async listIssues(request: IssueSyncRequest): Promise<IssueSyncOutcome> {
      const fetchImpl = request.fetchImpl ?? fetch;
      const pageSize = request.pageSize ?? DEFAULT_ISSUE_PAGE_SIZE;
      const maxRepositories = request.maxRepositories ?? DEFAULT_MAX_REPOSITORIES;
      const headers: Record<string, string> = {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${request.token}`,
        "X-GitHub-Api-Version": API_VERSION,
      };

      const { repositories, skipped } = selectRepositoriesToScan(
        request.projects,
        maxRepositories,
      );

      const issues: ProviderIssue[] = [];
      const checks: ResourceCheck[] = [];
      let scanned = 0;
      let failed = 0;
      let lastError: ProviderError | null = null;

      for (const repository of repositories) {
        try {
          // `sort=created` keeps the newest first, which is what the dashboard shows.
          const url = `${API_BASE}/repos/${repository}/issues?state=open&sort=created&direction=desc&per_page=${pageSize}`;
          const resource = cacheResourceKey(url);
          const answer = await requestJsonConditional<unknown>({
            url,
            headers,
            fetchImpl,
            signal: request.signal,
            classifyError: classifyGitHubError,
            validator: request.cache?.get(resource),
          });

          if (answer.notModified) {
            checks.push({ resource, repository, notModified: true, validator: null });
            scanned += 1;
            continue;
          }

          if (!Array.isArray(answer.data)) {
            throw new ProviderError(
              "INVALID_RESPONSE",
              "GitHub n'a pas renvoyé une liste d'issues.",
              { status: answer.response.status },
            );
          }

          // Normalised in full before anything is recorded: one malformed issue
          // fails the repository, and no validator is kept for a half-read list.
          const repositoryIssues = (answer.data as GitHubIssue[]).map((raw) =>
            normaliseGitHubIssue(raw, repository),
          );
          issues.push(...repositoryIssues);
          checks.push({ resource, repository, notModified: false, validator: answer.validator });

          scanned += 1;
        } catch (error) {
          // A quota or a revoked token concerns the connection, not one repository:
          // failing the run is better than storing a view that looks complete.
          if (
            error instanceof ProviderError &&
            (error.code === "RATE_LIMITED" || error.code === "UNAUTHORIZED")
          ) {
            throw error;
          }

          if (!(error instanceof ProviderError)) {
            throw error;
          }

          // A renamed, moved or deleted repository must not cost the other ones.
          failed += 1;
          lastError = error;
        }
      }

      // Every repository refused: the run has nothing to report, so it fails and the
      // connection is marked in error instead of publishing an empty issue list.
      if (repositories.length > 0 && scanned === 0 && lastError) {
        throw lastError;
      }

      return {
        supported: true,
        issues,
        checks,
        fetchedAt: new Date(),
        repositoriesScanned: scanned,
        repositoriesSkipped: skipped,
        repositoriesFailed: failed,
      };
    },

    /**
     * Milestones of the same repositories, one request each.
     *
     * `state=all` so a closed milestone keeps its history: a shipped milestone is
     * information, and it is what makes the due dates comparable. GitHub returns the
     * counters, which are the authoritative ones.
     */
    async listMilestones(request: IssueSyncRequest): Promise<MilestoneSyncOutcome> {
      const fetchImpl = request.fetchImpl ?? fetch;
      const pageSize = request.pageSize ?? DEFAULT_MILESTONE_PAGE_SIZE;
      const maxRepositories = request.maxRepositories ?? DEFAULT_MAX_REPOSITORIES;
      const headers: Record<string, string> = {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${request.token}`,
        "X-GitHub-Api-Version": API_VERSION,
      };

      const { repositories, skipped } = selectRepositoriesToScan(
        request.projects,
        maxRepositories,
      );

      const milestones: ProviderMilestone[] = [];
      const checks: ResourceCheck[] = [];
      let scanned = 0;
      let failed = 0;
      let lastError: ProviderError | null = null;

      for (const repository of repositories) {
        try {
          const url = `${API_BASE}/repos/${repository}/milestones?state=all&sort=due_on&direction=asc&per_page=${pageSize}`;
          const resource = cacheResourceKey(url);
          const answer = await requestJsonConditional<unknown>({
            url,
            headers,
            fetchImpl,
            signal: request.signal,
            classifyError: classifyGitHubError,
            validator: request.cache?.get(resource),
          });

          if (answer.notModified) {
            checks.push({ resource, repository, notModified: true, validator: null });
            scanned += 1;
            continue;
          }

          if (!Array.isArray(answer.data)) {
            throw new ProviderError(
              "INVALID_RESPONSE",
              "GitHub n'a pas renvoyé une liste de jalons.",
              { status: answer.response.status },
            );
          }

          const repositoryMilestones = (answer.data as GitHubMilestone[]).map((raw) =>
            normaliseGitHubMilestone(raw, repository),
          );
          milestones.push(...repositoryMilestones);
          checks.push({ resource, repository, notModified: false, validator: answer.validator });

          scanned += 1;
        } catch (error) {
          if (
            error instanceof ProviderError &&
            (error.code === "RATE_LIMITED" || error.code === "UNAUTHORIZED")
          ) {
            throw error;
          }

          if (!(error instanceof ProviderError)) {
            throw error;
          }

          failed += 1;
          lastError = error;
        }
      }

      if (repositories.length > 0 && scanned === 0 && lastError) {
        throw lastError;
      }

      return {
        supported: true,
        milestones,
        checks,
        fetchedAt: new Date(),
        repositoriesScanned: scanned,
        repositoriesSkipped: skipped,
        repositoriesFailed: failed,
      };
    },

    /**
     * Recent GitHub Actions runs of the same repositories, one request each (DA-03).
     *
     * One page of `DEFAULT_CI_PAGE_SIZE` runs, newest first, on the same bounded
     * selection as issues: at most one extra request per repository read. Unlike
     * issues, a refused repository never fails the run — a token may read issues
     * without the Actions permission, and that repository's CI is then reported as
     * unavailable. Only an exhausted quota stops the run, since every following
     * request would fail the same way.
     */
    async listCiRuns(request: IssueSyncRequest): Promise<CiSyncOutcome> {
      const fetchImpl = request.fetchImpl ?? fetch;
      const pageSize = request.pageSize ?? DEFAULT_CI_PAGE_SIZE;
      const maxRepositories = request.maxRepositories ?? DEFAULT_MAX_REPOSITORIES;
      const headers: Record<string, string> = {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${request.token}`,
        "X-GitHub-Api-Version": API_VERSION,
      };

      const { repositories, skipped } = selectRepositoriesToScan(
        request.projects,
        maxRepositories,
      );

      const results: CiRepositoryResult[] = [];

      for (const repository of repositories) {
        try {
          const { data, response }: { data: unknown; response: Response } =
            await requestJson<unknown>({
              url: `${API_BASE}/repos/${repository}/actions/runs?per_page=${pageSize}`,
              headers,
              fetchImpl,
              signal: request.signal,
              classifyError: classifyGitHubError,
            });

          const runs =
            typeof data === "object" && data !== null
              ? (data as { workflow_runs?: unknown }).workflow_runs
              : undefined;

          if (!Array.isArray(runs)) {
            throw new ProviderError(
              "INVALID_RESPONSE",
              "GitHub n'a pas renvoyé une liste d'exécutions.",
              { status: response.status },
            );
          }

          results.push({
            repository,
            read: true,
            runs: (runs as GitHubWorkflowRun[]).map((run) =>
              normaliseGitHubWorkflowRun(run, repository),
            ),
          });
        } catch (error) {
          if (!(error instanceof ProviderError) || error.code === "RATE_LIMITED") {
            throw error;
          }

          results.push({ repository, read: false, errorCode: error.toSafeMessage() });
        }
      }

      return {
        supported: true,
        repositories: results,
        fetchedAt: new Date(),
        repositoriesScanned: results.filter((result) => result.read).length,
        repositoriesSkipped: skipped,
        repositoriesFailed: results.filter((result) => !result.read).length,
      };
    },

    // Delivery history (M14-02): one GraphQL query per repository, see github-delivery.ts.
    listDelivery: (request: IssueSyncRequest) => listGitHubDelivery(request),
  };
}

export function normaliseGitHubWorkflowRun(
  run: GitHubWorkflowRun,
  repository: string,
): ProviderCiRun {
  const normalised: ProviderCiRun = {
    externalId: String(run.id ?? ""),
    repository,
    workflowName: typeof run.name === "string" ? run.name : "",
    branch: typeof run.head_branch === "string" && run.head_branch ? run.head_branch : null,
    status: typeof run.status === "string" ? run.status : "",
    conclusion: typeof run.conclusion === "string" ? run.conclusion : null,
    url: typeof run.html_url === "string" ? run.html_url : "",
    // `run_started_at` moves on a re-run attempt; older payloads only carry `created_at`.
    startedAt: parseProviderInstant(run.run_started_at ?? run.created_at, "GITHUB"),
    updatedAt: parseProviderInstant(run.updated_at, "GITHUB"),
  };

  if (
    !normalised.externalId ||
    !normalised.workflowName ||
    !normalised.status ||
    !normalised.url
  ) {
    throw new ProviderError(
      "INVALID_RESPONSE",
      "Exécution GitHub incomplète : identifiant, workflow, état ou URL manquant.",
    );
  }

  return normalised;
}

export function normaliseGitHubIssue(issue: GitHubIssue, repository: string): ProviderIssue {
  const normalised: ProviderIssue = {
    externalId: String(issue.id ?? ""),
    // Presence of `pull_request` is the only reliable discriminator: the endpoint
    // returns both kinds, and a pull request is not an unanswered report.
    kind: issue.pull_request === undefined || issue.pull_request === null
      ? "ISSUE"
      : "PULL_REQUEST",
    repository,
    number: typeof issue.number === "number" ? issue.number : 0,
    title: typeof issue.title === "string" ? issue.title : "",
    url: typeof issue.html_url === "string" ? issue.html_url : "",
    authorLogin: authorLogin(issue.user),
    assignees: issueAssignees(issue.assignees),
    milestone: issueMilestone(issue.milestone),
    commentsCount: typeof issue.comments === "number" ? issue.comments : 0,
    labels: labelNames(issue.labels),
    openedAt: parseProviderInstant(issue.created_at, "GITHUB"),
    activityAt: parseProviderInstant(issue.updated_at, "GITHUB"),
  };

  assertIssueShape(normalised, "GITHUB");
  return normalised;
}

export function normaliseGitHubMilestone(
  milestone: GitHubMilestone,
  repository: string,
): ProviderMilestone {
  const normalised: ProviderMilestone = {
    externalId: String(milestone.id ?? ""),
    repository,
    number: typeof milestone.number === "number" ? milestone.number : 0,
    title: typeof milestone.title === "string" ? milestone.title : "",
    state: typeof milestone.state === "string" ? milestone.state : "unknown",
    // A milestone without a due date is legitimate: `null`, never a made-up date.
    dueOn: milestone.due_on ? parseProviderInstant(milestone.due_on, "GITHUB") : null,
    issuesOpen: typeof milestone.open_issues === "number" ? milestone.open_issues : 0,
    issuesClosed: typeof milestone.closed_issues === "number" ? milestone.closed_issues : 0,
    url:
      typeof milestone.html_url === "string"
        ? milestone.html_url
        : `https://github.com/${repository}/milestones`,
  };

  assertMilestoneShape(normalised, "GITHUB");
  return normalised;
}

/**
 * The repositories to query first: the most recently pushed ones.
 *
 * A project without a usable push date is sorted last rather than treated as fresh.
 */
export function selectRepositoriesToScan(
  projects: readonly ProviderProject[],
  maxRepositories: number,
): { repositories: string[]; skipped: number } {
  const ordered = [...projects].sort(
    (left, right) => lastPushTime(right) - lastPushTime(left),
  );
  const selected = ordered.slice(0, Math.max(0, maxRepositories));

  return {
    repositories: selected.map((project) => project.name),
    skipped: Math.max(0, ordered.length - selected.length),
  };
}

function lastPushTime(project: ProviderProject): number {
  const value = project.metrics["lastPushAt"];
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;

  return Number.isNaN(parsed) ? 0 : parsed;
}

function authorLogin(user: unknown): string | null {
  if (typeof user !== "object" || user === null) {
    return null;
  }

  const login = (user as { login?: unknown }).login;
  return typeof login === "string" && login.length > 0 ? login : null;
}

/** Assignees arrive as user objects; only the logins are kept, and only a few. */
function issueAssignees(assignees: unknown): string[] {
  if (!Array.isArray(assignees)) {
    return [];
  }

  return assignees
    .map((assignee) =>
      typeof assignee === "object" && assignee !== null
        ? (assignee as { login?: unknown }).login
        : null,
    )
    .filter((login): login is string => typeof login === "string" && login.length > 0)
    .slice(0, MAX_ASSIGNEES);
}

/**
 * The milestone is reduced to its title.
 *
 * An issue payload carries only `title`, `number` and `state` here — no due date and no
 * counters, which live on the milestone resource. Storing the title is enough to filter
 * and to link the issue to the milestone description fetched on its own.
 */
function issueMilestone(milestone: unknown): string | null {
  if (typeof milestone !== "object" || milestone === null) {
    return null;
  }

  const title = (milestone as { title?: unknown }).title;
  return typeof title === "string" && title.length > 0 ? title : null;
}

/** Labels arrive either as strings or as objects; only the names are displayed. */
function labelNames(labels: unknown): string[] {
  if (!Array.isArray(labels)) {
    return [];
  }

  return labels
    .map((label) =>
      typeof label === "string"
        ? label
        : typeof label === "object" && label !== null
          ? (label as { name?: unknown }).name
          : null,
    )
    .filter((name): name is string => typeof name === "string" && name.length > 0)
    .slice(0, MAX_LABELS);
}
