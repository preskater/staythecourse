import { z } from "zod";

/**
 * Integrations module (GitHub, GitLab).
 *
 * Read-only by construction: only read scopes are requested, no adapter offers a
 * write operation, and nothing from a provider is stored except the normalised
 * fields the dashboard displays. GitLab may be self-hosted, so the instance URL
 * is part of the connection identity.
 */

export const INTEGRATION_PROVIDERS = ["GITHUB", "GITLAB"] as const;
export type IntegrationProvider = (typeof INTEGRATION_PROVIDERS)[number];

export const INTEGRATION_STATUSES = ["NOT_CONNECTED", "CONNECTED", "ERROR"] as const;
export type IntegrationStatus = (typeof INTEGRATION_STATUSES)[number];

/**
 * "No data" is not "not connected" and not "synchronisation failed": the three
 * states stay distinct, and a synchronisation error is never rendered as a zero.
 */
export type ConnectionState =
  | { kind: "NOT_CONNECTED" }
  | { kind: "CONNECTED"; lastSyncedAt: Date; projectCount: number }
  | { kind: "NEVER_SYNCED" }
  | { kind: "ERROR"; lastSyncError: string | null; lastSyncedAt: Date | null };

export type ProviderProject = {
  /** Identifier at the provider, kept to make re-synchronisations idempotent. */
  externalId: string;
  externalUrl: string;
  name: string;
  visibility: string | null;
  /** Only the fields the interface displays; never private source code. */
  metrics: Record<string, unknown>;
};

export const ISSUE_KINDS = ["ISSUE", "PULL_REQUEST"] as const;
export type IssueKind = (typeof ISSUE_KINDS)[number];

/**
 * One open issue or pull request, reduced to what the interface displays.
 *
 * There is deliberately no description and no comment body: pulling those in would
 * copy arbitrary provider content — which often carries credentials, customer names
 * or code — into this database and into its backups. The title, the number and the
 * link are enough to decide what to look at; the reading happens at the provider.
 */
export type ProviderIssue = {
  externalId: string;
  kind: IssueKind;
  /** Repository full name, for example "owner/repo". */
  repository: string;
  number: number;
  title: string;
  url: string;
  authorLogin: string | null;
  /** Assignees, by login. Empty means nobody has picked it up. */
  assignees: string[];
  /** Milestone title, or null when the issue is not attached to one. */
  milestone: string | null;
  commentsCount: number;
  labels: string[];
  /** Instant the issue was opened at the provider. */
  openedAt: Date;
  /** Instant of the last activity at the provider. */
  activityAt: Date;
};

/**
 * A milestone, normalised.
 *
 * The counters are the provider's own: they cover everything attached to the
 * milestone, not only the issues kept here. They are the authoritative figures, and
 * the interface says so rather than recomputing a smaller number that would look like
 * a contradiction.
 */
export type ProviderMilestone = {
  externalId: string;
  repository: string;
  number: number;
  title: string;
  /** "open" or "closed", as reported. */
  state: string;
  dueOn: Date | null;
  issuesOpen: number;
  issuesClosed: number;
  url: string;
};

/** One CI workflow run, reduced to the fields the interface displays (DA-03). */
export type ProviderCiRun = {
  externalId: string;
  repository: string;
  workflowName: string;
  branch: string | null;
  /** "queued", "in_progress", "completed"..., as reported. */
  status: string;
  /** `null` while the run is not completed. */
  conclusion: string | null;
  url: string;
  startedAt: Date;
  /** The provider's last update; the end of a completed run. */
  updatedAt: Date;
};

/** A pull request and its delivery metadata (M14-02). Never text beyond the title. */
export type ProviderPullRequest = {
  externalId: string;
  repository: string;
  number: number;
  title: string;
  url: string;
  authorLogin: string | null;
  state: string;
  isDraft: boolean;
  baseBranch: string;
  headBranch: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  commitsCount: number;
  commentsCount: number;
  reviewsCount: number;
  openedAt: Date;
  closedAt: Date | null;
  mergedAt: Date | null;
  updatedAt: Date;
  /** True when files, reviews, commits or links were cut by their bound. */
  childrenTruncated: boolean;
  files: { path: string; additions: number; deletions: number; changeType: string }[];
  reviews: { externalId: string; authorLogin: string | null; state: string; submittedAt: Date | null }[];
  commits: { sha: string; authorLogin: string | null; committedAt: Date }[];
  issueLinks: { repository: string; issueNumber: number; url: string }[];
};

export type ProviderRelease = {
  externalId: string;
  repository: string;
  tagName: string;
  name: string | null;
  url: string;
  isPrerelease: boolean;
  isDraft: boolean;
  releasedAt: Date;
  publishedAt: Date | null;
};

export type ProviderDeployment = {
  externalId: string;
  repository: string;
  environment: string;
  sha: string;
  state: string | null;
  deployedAt: Date;
  statusUpdatedAt: Date | null;
};

export type SyncOutcome = {
  projects: ProviderProject[];
  fetchedAt: Date;
};

export type ConnectionSummary = {
  id: string;
  provider: IntegrationProvider;
  instanceUrl: string;
  externalOwner: string | null;
  permissions: string[];
  status: IntegrationStatus;
  lastSyncedAt: Date | null;
  lastSyncError: string | null;
  /** A token is stored, but its value never leaves the server. */
  hasStoredToken: boolean;
  projectCount: number;
  /** Open issues and pull requests currently followed, zero when unsupported. */
  issueCount: number;
  /** Milestones currently followed, zero when unsupported. */
  milestoneCount: number;
};

/** Public host used when the connection targets the provider's own instance. */
export function publicInstanceLabel(provider: IntegrationProvider): string {
  return provider === "GITHUB" ? "github.com" : "gitlab.com";
}

export function describeInstance(
  provider: IntegrationProvider,
  instanceUrl: string,
): string {
  return instanceUrl.trim() === "" ? publicInstanceLabel(provider) : instanceUrl.trim();
}

export const connectionInputSchema = z.object({
  provider: z.enum(INTEGRATION_PROVIDERS),
  /** Empty string means the provider's public instance, never NULL. */
  instanceUrl: z
    .string()
    .trim()
    .transform((value) => value.replace(/\/+$/, ""))
    .refine(
      (value) => value === "" || /^https?:\/\/[^\s/]+/.test(value),
      "L'URL d'instance doit commencer par http:// ou https://",
    ),
  externalOwner: z.string().trim().max(200).nullable().default(null),
  /** Sent to the provider and stored encrypted. Never rendered back to the browser. */
  token: z.string().min(1, "Un jeton est requis pour se connecter."),
});

export type ConnectionInput = z.input<typeof connectionInputSchema>;

/** Derives the state a page must display, without inventing a value for missing data. */
export function describeConnectionState(connection: {
  status: IntegrationStatus;
  lastSyncedAt: Date | null;
  lastSyncError: string | null;
  projectCount: number;
}): ConnectionState {
  if (connection.status === "NOT_CONNECTED") {
    return { kind: "NOT_CONNECTED" };
  }

  if (connection.status === "ERROR") {
    return {
      kind: "ERROR",
      lastSyncError: connection.lastSyncError,
      lastSyncedAt: connection.lastSyncedAt,
    };
  }

  if (!connection.lastSyncedAt) {
    return { kind: "NEVER_SYNCED" };
  }

  return {
    kind: "CONNECTED",
    lastSyncedAt: connection.lastSyncedAt,
    projectCount: connection.projectCount,
  };
}

/** Statuses of a synchronisation run, as stored in `SyncRun`. */
export const SYNC_RUN_STATUSES = ["RUNNING", "SUCCESS", "PARTIAL", "FAILED"] as const;
export type SyncRunStatus = (typeof SYNC_RUN_STATUSES)[number];

/**
 * A successful synchronisation older than this is displayed as stale. 24 hours is a
 * display threshold, not a contract: a run happens when the owner (or a future
 * scheduler) triggers it, and the interface must say what it knows instead of
 * implying freshness.
 */
export const STALE_AFTER_HOURS = 24;

/** A `RUNNING` row older than this belonged to a process that stopped: not "in progress". */
export const RUN_ABANDONED_AFTER_MS = 60 * 60 * 1000;

export function isSyncStale(
  lastSyncedAt: Date,
  now: Date,
  staleAfterHours: number = STALE_AFTER_HOURS,
): boolean {
  return now.getTime() - lastSyncedAt.getTime() > staleAfterHours * 3_600_000;
}

/** One synchronisation run as the interface displays it. Counters are explained in the schema. */
export type SyncRunSummary = {
  id: string;
  connectionId: string;
  provider: IntegrationProvider;
  /** Public instance or self-hosted URL, so two connections stay distinguishable. */
  connectionLabel: string;
  status: SyncRunStatus;
  startedAt: Date;
  finishedAt: Date | null;
  fetched: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  retries: number;
  errorSummary: string | null;
};

export type SyncRunOutcome = {
  /** Short label for the status badge. */
  label: string;
  /** Why the run is partial, failed or slow — or null when there is nothing to add. */
  note: string | null;
  tone: "neutral" | "positive" | "negative" | "warning";
};

/**
 * Describes a stored run honestly:
 * - an empty success says "nothing to read" instead of an unexplained success;
 * - skipped or failed repositories are named, because their data is unknown;
 * - retries are reported, so a flaky provider stays visible;
 * - a `RUNNING` row left behind by a crashed process reads "interrompue".
 */
export function describeSyncRun(
  run: {
    status: SyncRunStatus;
    startedAt: Date;
    fetched: number;
    skipped: number;
    failed: number;
    retries: number;
    errorSummary: string | null;
  },
  options: { now?: Date; abandonedAfterMs?: number } = {},
): SyncRunOutcome {
  const now = options.now ?? new Date();
  const abandonedAfterMs = options.abandonedAfterMs ?? RUN_ABANDONED_AFTER_MS;

  if (
    run.status === "RUNNING" &&
    now.getTime() - run.startedAt.getTime() > abandonedAfterMs
  ) {
    return {
      label: "Interrompue",
      note: "Le processus s'est arrêté avant la fin de la synchronisation.",
      tone: "warning",
    };
  }

  const details: string[] = [];
  if (run.errorSummary) {
    details.push(run.errorSummary);
  }
  if (run.skipped > 0) {
    details.push(`${run.skipped} dépôt(s) non lu(s) — leurs données restent inconnues`);
  }
  if (run.failed > 0) {
    details.push(`${run.failed} dépôt(s) en échec`);
  }
  if (run.retries > 0) {
    details.push(`${run.retries} relance(s) après erreur transitoire`);
  }
  const note = details.length > 0 ? details.join(" · ") : null;

  switch (run.status) {
    case "RUNNING":
      return { label: "En cours", note, tone: "neutral" };
    case "SUCCESS":
      // An empty result is a factual outcome, not a quiet victory: say there was
      // nothing to read rather than display an unexplained success.
      return run.fetched === 0
        ? { label: "Réussie — rien à lire", note, tone: "neutral" }
        : { label: "Réussie", note, tone: "positive" };
    case "PARTIAL":
      return { label: "Partielle", note, tone: "warning" };
    case "FAILED":
      return { label: "Échec", note, tone: "negative" };
  }
}

/** Human duration of a finished run; an unfinished run is not given one. */
export function formatRunDuration(startedAt: Date, finishedAt: Date | null): string {
  if (!finishedAt) {
    return "en cours";
  }

  const seconds = Math.max(
    0,
    Math.round((finishedAt.getTime() - startedAt.getTime()) / 1000),
  );
  if (seconds < 60) {
    return `${seconds} s`;
  }

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rest = seconds % 60;
    return rest === 0 ? `${minutes} min` : `${minutes} min ${String(rest).padStart(2, "0")} s`;
  }

  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes === 0 ? `${hours} h` : `${hours} h ${String(restMinutes).padStart(2, "0")}`;
}
