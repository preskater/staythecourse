import {
  conditionalHeaders,
  readValidator,
  type CacheValidator,
} from "./cache";
import type {
  IntegrationProvider,
  ProviderCiRun,
  ProviderDeployment,
  ProviderIssue,
  ProviderPullRequest,
  ProviderRelease,
  ProviderMilestone,
  ProviderProject,
  SyncOutcome,
} from "./domain";

/**
 * Provider adapter contract.
 *
 * Every provider is isolated behind this interface so that pagination, rate
 * limiting and error mapping are handled once per provider and the rest of the
 * application only sees normalised projects.
 *
 * The token is only ever used server-side. Tests inject a fake `fetchImpl`: no
 * test performs a real network call and no test needs a real token.
 */

export type ProviderErrorCode =
  | "UNAUTHORIZED"
  /** Credential valid but missing a permission (for example an AI usage-read scope). */
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "NETWORK"
  | "HTTP_ERROR"
  | "INVALID_RESPONSE";

export class ProviderError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    message: string,
    readonly details: { status?: number; retryAfterSeconds?: number } = {},
  ) {
    super(message);
    this.name = "ProviderError";
  }

  /** Message safe to persist and display: no token, no response body. */
  toSafeMessage(): string {
    const status = this.details.status ? ` (HTTP ${this.details.status})` : "";
    return `${this.code}${status}`;
  }
}

export type SyncRequest = {
  /** Provider token. Server-side only. */
  token: string;
  /** Empty string means the provider's public instance. */
  instanceUrl: string;
  /**
   * Scope to track: an organisation slug on GitHub, a group path on GitLab.
   * `null` means "everything the token can read".
   */
  owner: string | null;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  /** Bounds a synchronisation so one run cannot loop forever. */
  maxPages?: number;
  pageSize?: number;
};

export interface IntegrationAdapter {
  readonly provider: IntegrationProvider;
  /** Read-only permissions: a display-only integration never asks for more. */
  readonly requiredScopes: readonly string[];
  /**
   * False when open issues are deliberately not fetched for this provider. The
   * interface then says so instead of showing an empty list, which would read as
   * "nothing is open".
   */
  readonly tracksIssues: boolean;
  /** Same idea for milestones: false means the interface must say "not tracked". */
  readonly tracksMilestones: boolean;
  listProjects(request: SyncRequest): Promise<SyncOutcome>;
  listIssues(request: IssueSyncRequest): Promise<IssueSyncOutcome>;
  listMilestones(request: IssueSyncRequest): Promise<MilestoneSyncOutcome>;
  listCiRuns(request: IssueSyncRequest): Promise<CiSyncOutcome>;
  /** Delivery history (M14-02): pull requests, releases, deployments. */
  listDelivery(request: IssueSyncRequest): Promise<DeliverySyncOutcome>;
}

/**
 * Issues are fetched per repository, which is more requests than listing projects,
 * so the run is bounded on purpose: a synchronisation must stay short and must not
 * burn a whole rate-limit window on repositories nobody touched for a year.
 */
export type IssueSyncRequest = SyncRequest & {
  /** Projects returned by `listProjects` in the same run. */
  projects: readonly ProviderProject[];
  /** Upper bound on the repositories queried. The most recently active come first. */
  maxRepositories?: number;
  /** Upper bound on the issues kept per repository. */
  pageSize?: number;
  /**
   * Validators that may be sent this run, by resource key (DA-04). Absent or empty:
   * every resource is read in full, which is always correct.
   */
  cache?: ReadonlyMap<string, CacheValidator>;
};

/**
 * One per-repository resource checked successfully this run (DA-04).
 *
 * `notModified` means the provider answered 304: the rows stored for that repository
 * are current and were not sent again. Otherwise the resource was read in full and
 * `validator` holds what to send next time (`null` when the answer carried none).
 */
export type ResourceCheck = {
  resource: string;
  repository: string;
  notModified: boolean;
  validator: CacheValidator | null;
};

/** How much of the repository list a bounded scan actually covered. */
export type RepositoryScanSummary = {
  /** Repositories actually read during this run. */
  repositoriesScanned: number;
  /** Repositories left out because of the bound: their data is unknown, not zero. */
  repositoriesSkipped: number;
  /** Repositories the provider refused to answer for (renamed, moved, deleted). */
  repositoriesFailed: number;
};

export type IssueSyncOutcome = RepositoryScanSummary & {
  /** False for a provider whose issues are not tracked; the list is then empty. */
  supported: boolean;
  /** Issues of the repositories read in full; a 304 repository contributes none. */
  issues: ProviderIssue[];
  /** Every repository checked successfully, read in full or not modified. */
  checks: ResourceCheck[];
  fetchedAt: Date;
};

export type MilestoneSyncOutcome = RepositoryScanSummary & {
  supported: boolean;
  milestones: ProviderMilestone[];
  checks: ResourceCheck[];
  fetchedAt: Date;
};

/**
 * CI runs of one repository (DA-03). A refusal is kept per repository, with its safe
 * code: CI permissions are often narrower than issue permissions, so a refused read
 * means "unavailable here", not a failed synchronisation.
 */
export type CiRepositoryResult =
  | { repository: string; read: true; runs: ProviderCiRun[] }
  | { repository: string; read: false; errorCode: string };

export type CiSyncOutcome = RepositoryScanSummary & {
  /** False for a provider whose CI is not fetched; the list is then empty. */
  supported: boolean;
  /** One entry per repository requested, in the order of the bounded selection. */
  repositories: CiRepositoryResult[];
  fetchedAt: Date;
};

/**
 * Delivery data of one repository (M14-02). A refusal is kept per repository with its
 * safe code, like CI: a token may lack the pull-request or deployment permission on
 * one repository without the whole synchronisation failing.
 */
export type DeliveryRepositoryResult =
  | {
      repository: string;
      read: true;
      pullRequests: ProviderPullRequest[];
      releases: ProviderRelease[];
      deployments: ProviderDeployment[];
      /** True when more pull requests were updated within the window than the bound. */
      windowTruncated: boolean;
    }
  | { repository: string; read: false; errorCode: string };

export type DeliverySyncOutcome = RepositoryScanSummary & {
  supported: boolean;
  repositories: DeliveryRepositoryResult[];
  /** Start of the window read: items updated (pull requests) or created before it are not read. */
  windowStart: Date;
  fetchedAt: Date;
};

export type JsonResponse<T> = {
  data: T;
  response: Response;
};

/**
 * Performs one request and maps transport and protocol failures to `ProviderError`.
 *
 * `classifyError` is provided by the adapter because rate-limit and scope
 * signals differ between providers.
 */
type RequestOptions = {
  url: string;
  headers: Record<string, string>;
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
  classifyError: (response: Response) => ProviderError;
};

async function send(options: RequestOptions): Promise<Response> {
  try {
    return await options.fetchImpl(options.url, {
      method: "GET",
      headers: options.headers,
      signal: options.signal,
      // Never served from a local HTTP cache: revalidation is explicit (DA-04).
      cache: "no-store",
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new ProviderError("NETWORK", "Synchronisation annulée.");
    }
    throw new ProviderError(
      "NETWORK",
      `Le fournisseur est injoignable : ${error instanceof Error ? error.message : "erreur inconnue"}`,
    );
  }
}

export async function requestJson<T>(options: RequestOptions): Promise<JsonResponse<T>> {
  const response = await send(options);

  if (!response.ok) {
    throw options.classifyError(response);
  }

  return { data: await parseJson<T>(response), response };
}

export type ConditionalResponse<T> =
  | { notModified: true; response: Response }
  | { notModified: false; data: T; response: Response; validator: CacheValidator | null };

/**
 * `requestJson`, sending the stored validator when there is one (DA-04).
 *
 * A 304 is only accepted as an answer to a conditional request: a 304 to a request
 * that sent no validator cannot vouch for anything stored, so it is an invalid
 * response, never "unchanged".
 */
export async function requestJsonConditional<T>(
  options: RequestOptions & { validator?: CacheValidator | null },
): Promise<ConditionalResponse<T>> {
  const validatorHeaders = conditionalHeaders(options.validator);
  const response = await send({
    ...options,
    headers: { ...options.headers, ...validatorHeaders },
  });

  if (response.status === 304) {
    if (Object.keys(validatorHeaders).length === 0) {
      throw new ProviderError(
        "INVALID_RESPONSE",
        "Réponse 304 à une requête non conditionnelle.",
        { status: 304 },
      );
    }

    return { notModified: true, response };
  }

  if (!response.ok) {
    throw options.classifyError(response);
  }

  return {
    notModified: false,
    data: await parseJson<T>(response),
    response,
    validator: readValidator(response.headers),
  };
}

async function parseJson<T>(response: Response): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch {
    throw new ProviderError(
      "INVALID_RESPONSE",
      "Réponse illisible du fournisseur.",
      { status: response.status },
    );
  }
}

export function parseRetryAfterSeconds(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (!header) {
    return undefined;
  }

  const seconds = Number(header);
  return Number.isFinite(seconds) ? seconds : undefined;
}

/**
 * Whether a repository has a description: `null` when the payload did not say (the
 * key is absent), which the health indicators show as unavailable rather than missing.
 */
export function descriptionPresence(description: unknown): boolean | null {
  if (description === undefined) {
    return null;
  }

  return typeof description === "string" && description.trim().length > 0;
}

/** Validates one normalised project, so a malformed payload fails loudly. */
export function assertProjectShape(
  project: Partial<{ externalId: unknown; externalUrl: unknown; name: unknown }>,
  provider: IntegrationProvider,
): void {
  const isText = (value: unknown): value is string =>
    typeof value === "string" && value.length > 0;

  if (
    !isText(project.externalId) ||
    !isText(project.externalUrl) ||
    !isText(project.name)
  ) {
    throw new ProviderError(
      "INVALID_RESPONSE",
      `Projet ${provider} incomplet : identifiant, nom ou URL manquant.`,
    );
  }
}

/**
 * Validates one normalised issue.
 *
 * An issue without an identifier, a title or a link cannot be displayed and would
 * silently pollute the table, so the run fails instead of storing a half-row.
 */
export function assertIssueShape(
  issue: Partial<{
    externalId: unknown;
    title: unknown;
    url: unknown;
    number: unknown;
    openedAt: unknown;
  }>,
  provider: IntegrationProvider,
): void {
  const isText = (value: unknown): value is string =>
    typeof value === "string" && value.length > 0;

  if (
    !isText(issue.externalId) ||
    !isText(issue.title) ||
    !isText(issue.url) ||
    typeof issue.number !== "number" ||
    issue.number <= 0 ||
    !(issue.openedAt instanceof Date) ||
    Number.isNaN(issue.openedAt.getTime())
  ) {
    throw new ProviderError(
      "INVALID_RESPONSE",
      `Issue ${provider} incomplète : identifiant, numéro, titre, URL ou date manquant.`,
    );
  }
}

/**
 * Validates one normalised milestone. A milestone without an identifier or a title
 * could not be displayed nor filtered, so it fails the run instead of being stored.
 */
export function assertMilestoneShape(
  milestone: Partial<{ externalId: unknown; title: unknown; number: unknown }>,
  provider: IntegrationProvider,
): void {
  const isText = (value: unknown): value is string =>
    typeof value === "string" && value.length > 0;

  if (
    !isText(milestone.externalId) ||
    !isText(milestone.title) ||
    typeof milestone.number !== "number"
  ) {
    throw new ProviderError(
      "INVALID_RESPONSE",
      `Jalon ${provider} incomplet : identifiant, numéro ou titre manquant.`,
    );
  }
}

/**
 * Reads an ISO instant returned by a provider.
 *
 * A missing or unreadable date is a malformed response: defaulting it to now would
 * make an ancient issue look new, which is exactly the mistake this feature exists
 * to prevent.
 */
export function parseProviderInstant(
  value: unknown,
  provider: IntegrationProvider,
): Date {
  const parsed = typeof value === "string" ? new Date(value) : new Date(Number.NaN);

  if (Number.isNaN(parsed.getTime())) {
    throw new ProviderError(
      "INVALID_RESPONSE",
      `Date illisible renvoyée par ${provider}.`,
    );
  }

  return parsed;
}
