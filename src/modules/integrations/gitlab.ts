import {
  assertProjectShape,
  descriptionPresence,
  parseRetryAfterSeconds,
  ProviderError,
  requestJson,
  type CiSyncOutcome,
  type DeliverySyncOutcome,
  type IntegrationAdapter,
  type IssueSyncOutcome,
  type MilestoneSyncOutcome,
  type SyncRequest,
} from "./adapter";
import type { ProviderProject, SyncOutcome } from "./domain";

/**
 * GitLab adapter (read-only), usable against gitlab.com or a self-hosted instance.
 *
 * The token needs the `read_api` scope and nothing else: this integration only
 * displays project metadata.
 */
const PUBLIC_INSTANCE = "https://gitlab.com";
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 5;

type GitLabProject = {
  id?: unknown;
  path_with_namespace?: unknown;
  web_url?: unknown;
  visibility?: unknown;
  default_branch?: unknown;
  star_count?: unknown;
  forks_count?: unknown;
  open_issues_count?: unknown;
  last_activity_at?: unknown;
  description?: unknown;
  topics?: unknown;
  /** Older instances (before 14.5) name the topics this way. */
  tag_list?: unknown;
};

/** Normalises the configured instance URL, falling back to gitlab.com. */
export function resolveInstanceBase(instanceUrl: string): string {
  const trimmed = instanceUrl.trim().replace(/\/+$/, "");

  if (trimmed === "") {
    return PUBLIC_INSTANCE;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ProviderError(
      "INVALID_RESPONSE",
      "L'URL de l'instance GitLab est invalide.",
    );
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new ProviderError(
      "INVALID_RESPONSE",
      "L'URL de l'instance GitLab doit utiliser http ou https.",
    );
  }

  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
}

/** `x-next-page` is empty on the last page. */
export function nextPageNumber(header: string | null): number | null {
  if (!header) {
    return null;
  }

  const page = Number(header);
  return Number.isInteger(page) && page > 0 ? page : null;
}

export function classifyGitLabError(response: Response): ProviderError {
  const status = response.status;

  if (status === 401 || status === 403) {
    return new ProviderError(
      "UNAUTHORIZED",
      "Jeton GitLab refusé ou permissions insuffisantes (scope read_api requis).",
      { status },
    );
  }

  if (status === 404) {
    return new ProviderError(
      "NOT_FOUND",
      "Groupe GitLab introuvable sur cette instance.",
      { status },
    );
  }

  if (status === 429) {
    return new ProviderError("RATE_LIMITED", "Quota GitLab atteint.", {
      status,
      retryAfterSeconds: parseRetryAfterSeconds(response),
    });
  }

  return new ProviderError("HTTP_ERROR", "Erreur GitLab.", { status });
}

export function normaliseGitLabProject(project: GitLabProject): ProviderProject {
  const normalised: ProviderProject = {
    externalId: String(project.id ?? ""),
    externalUrl: typeof project.web_url === "string" ? project.web_url : "",
    name:
      typeof project.path_with_namespace === "string"
        ? project.path_with_namespace
        : "",
    visibility: typeof project.visibility === "string" ? project.visibility : null,
    metrics: {
      defaultBranch: project.default_branch ?? null,
      stars: typeof project.star_count === "number" ? project.star_count : null,
      forks: typeof project.forks_count === "number" ? project.forks_count : null,
      openIssues:
        typeof project.open_issues_count === "number"
          ? project.open_issues_count
          : null,
      lastActivityAt: project.last_activity_at ?? null,
      // Repository hygiene (DA-05): presence only, never the text itself.
      hasDescription: descriptionPresence(project.description),
      topicCount: Array.isArray(project.topics)
        ? project.topics.length
        : Array.isArray(project.tag_list)
          ? project.tag_list.length
          : null,
    },
  };

  assertProjectShape(normalised, "GITLAB");
  return normalised;
}

export function createGitLabAdapter(): IntegrationAdapter {
  return {
    provider: "GITLAB",
    requiredScopes: ["read_api"],
    /**
     * Issues are not fetched from GitLab, and the interface says so.
     *
     * Two reasons, both deliberate. A self-hosted instance is usually a company one:
     * AGENTS.md requires checking the internal policy and never pulling more than what
     * is explicitly authorised, and an issue title is already company content. And the
     * `read_api` scope granted here authorises project metadata, not a broader read.
     * Enabling it is a decision to take with the owner of that instance, not a default.
     */
    tracksIssues: false,
    /** Same decision as `tracksIssues`: nothing beyond project metadata is read. */
    tracksMilestones: false,

    async listProjects(request: SyncRequest): Promise<SyncOutcome> {
      const fetchImpl = request.fetchImpl ?? fetch;
      const pageSize = request.pageSize ?? DEFAULT_PAGE_SIZE;
      const maxPages = request.maxPages ?? DEFAULT_MAX_PAGES;
      const base = resolveInstanceBase(request.instanceUrl);
      const headers: Record<string, string> = {
        Accept: "application/json",
        // GitLab accepts a personal, project or group access token here.
        "PRIVATE-TOKEN": request.token,
      };

      const path = request.owner
        ? `/api/v4/groups/${encodeURIComponent(request.owner)}/projects`
        : "/api/v4/projects";

      const projects: ProviderProject[] = [];
      let page = 1;

      while (page <= maxPages) {
        const url = `${base}${path}?per_page=${pageSize}&page=${page}&simple=true`;

        const { data, response } = await requestJson<unknown>({
          url,
          headers,
          fetchImpl,
          signal: request.signal,
          classifyError: classifyGitLabError,
        });

        if (!Array.isArray(data)) {
          throw new ProviderError(
            "INVALID_RESPONSE",
            "GitLab n'a pas renvoyé une liste de projets.",
            { status: response.status },
          );
        }

        for (const project of data as GitLabProject[]) {
          projects.push(normaliseGitLabProject(project));
        }

        const next = nextPageNumber(response.headers.get("x-next-page"));
        if (next === null || next > maxPages) {
          break;
        }
        page = next;
      }

      return { projects, fetchedAt: new Date() };
    },

    async listIssues(): Promise<IssueSyncOutcome> {
      // No request is made: see `tracksIssues` above.
      return {
        supported: false,
        issues: [],
        checks: [],
        fetchedAt: new Date(),
        repositoriesScanned: 0,
        repositoriesSkipped: 0,
        repositoriesFailed: 0,
      };
    },

    async listMilestones(): Promise<MilestoneSyncOutcome> {
      return {
        supported: false,
        milestones: [],
        checks: [],
        fetchedAt: new Date(),
        repositoriesScanned: 0,
        repositoriesSkipped: 0,
        repositoriesFailed: 0,
      };
    },

    // GitLab delivery history arrives with M14-03.
    async listDelivery(): Promise<DeliverySyncOutcome> {
      return {
        supported: false,
        repositories: [],
        windowStart: new Date(),
        fetchedAt: new Date(),
        repositoriesScanned: 0,
        repositoriesSkipped: 0,
        repositoriesFailed: 0,
      };
    },

    // GitLab pipelines are not read yet (DA-03 first pass): the interface says so.
    async listCiRuns(): Promise<CiSyncOutcome> {
      return {
        supported: false,
        repositories: [],
        fetchedAt: new Date(),
        repositoriesScanned: 0,
        repositoriesSkipped: 0,
        repositoriesFailed: 0,
      };
    },
  };
}
