import { getPrisma } from "@/lib/db";
import { decodeEncryptionKey, decryptSecret, encryptSecret } from "@/lib/crypto";
import { getServerEnv } from "@/lib/env";
import type { ResourceCheck, CiRepositoryResult, DeliveryRepositoryResult } from "./adapter";
import { CACHE_MAX_AGE_DAYS, type CacheEntryLike } from "./cache";
import {
  describeInstance,
  type ConnectionSummary,
  type IntegrationProvider,
  type IntegrationStatus,
  type IssueKind,
  type ProviderIssue,
  type ProviderMilestone,
  type ProviderProject,
  type SyncRunStatus,
  type SyncRunSummary,
} from "./domain";

/**
 * Persistence for provider connections.
 *
 * A token is encrypted before it is written and is never read back into a
 * response: `listConnections` returns `hasStoredToken` instead of the value.
 */

function encryptionKey(): Buffer {
  return decodeEncryptionKey(getServerEnv().INTEGRATION_ENCRYPTION_KEY);
}

export async function listConnections(
  workspaceId: string,
): Promise<ConnectionSummary[]> {
  const rows = await getPrisma().integrationConnection.findMany({
    where: { workspaceId },
    orderBy: { provider: "asc" },
    select: {
      id: true,
      provider: true,
      instanceUrl: true,
      externalOwner: true,
      permissions: true,
      status: true,
      lastSyncedAt: true,
      lastSyncError: true,
      credentialsCiphertext: true,
      _count: { select: { snapshots: true, issues: true, milestones: true } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    provider: row.provider as IntegrationProvider,
    instanceUrl: row.instanceUrl,
    externalOwner: row.externalOwner,
    permissions: row.permissions,
    status: row.status as IntegrationStatus,
    lastSyncedAt: row.lastSyncedAt,
    lastSyncError: row.lastSyncError,
    hasStoredToken: Boolean(row.credentialsCiphertext),
    projectCount: row._count.snapshots,
    issueCount: row._count.issues,
    milestoneCount: row._count.milestones,
  }));
}

export type ConnectionWithSecret = {
  id: string;
  workspaceId: string;
  provider: IntegrationProvider;
  instanceUrl: string;
  externalOwner: string | null;
  token: string | null;
};

/** Server-internal: the only function that decrypts a token. */
export async function findConnectionForSync(
  workspaceId: string,
  connectionId: string,
): Promise<ConnectionWithSecret | null> {
  const row = await getPrisma().integrationConnection.findFirst({
    where: { id: connectionId, workspaceId },
    select: {
      id: true,
      workspaceId: true,
      provider: true,
      instanceUrl: true,
      externalOwner: true,
      credentialsCiphertext: true,
    },
  });

  if (!row) {
    return null;
  }

  return {
    id: row.id,
    workspaceId: row.workspaceId,
    provider: row.provider as IntegrationProvider,
    instanceUrl: row.instanceUrl,
    externalOwner: row.externalOwner,
    token: row.credentialsCiphertext
      ? decryptStoredToken(row.credentialsCiphertext)
      : null,
  };
}

/**
 * A token written with a previous encryption key must mark the connection as
 * broken, not crash an entire synchronisation run. Returning `null` lets the
 * caller report "credential unreadable, reconnect" instead of failing blindly.
 */
function decryptStoredToken(ciphertext: string): string | null {
  try {
    return decryptSecret(ciphertext, encryptionKey());
  } catch {
    return null;
  }
}

export async function upsertConnection(input: {
  workspaceId: string;
  provider: IntegrationProvider;
  instanceUrl: string;
  externalOwner: string | null;
  permissions: string[];
  token: string;
  status?: IntegrationStatus;
}): Promise<{ id: string }> {
  const credentialsCiphertext = encryptSecret(input.token, encryptionKey());

  const connection = await getPrisma().integrationConnection.upsert({
    where: {
      workspaceId_provider_instanceUrl: {
        workspaceId: input.workspaceId,
        provider: input.provider,
        instanceUrl: input.instanceUrl,
      },
    },
    create: {
      workspaceId: input.workspaceId,
      provider: input.provider,
      instanceUrl: input.instanceUrl,
      externalOwner: input.externalOwner,
      permissions: input.permissions,
      credentialsCiphertext,
      status: input.status ?? "CONNECTED",
    },
    update: {
      externalOwner: input.externalOwner,
      permissions: input.permissions,
      credentialsCiphertext,
      status: input.status ?? "CONNECTED",
      // A new token clears the previous failure.
      lastSyncError: null,
    },
    select: { id: true },
  });

  // A new token may see other repositories, and GitHub validators depend on the
  // credentials: none of the previous ones may be sent with it (DA-04).
  await getPrisma().providerCacheEntry.deleteMany({
    where: { connectionId: connection.id },
  });

  return connection;
}

/**
 * Stores the normalised projects of one synchronisation.
 *
 * Upserting on (connectionId, externalId) makes a re-run idempotent: replaying a
 * synchronisation updates rows instead of duplicating them.
 *
 * `pruneMissing` deletes snapshots the provider no longer returns. It is only
 * safe once a synchronisation has completed **all** its pages: a partial run
 * would otherwise erase projects that were merely not fetched.
 */
export async function saveSnapshots(input: {
  connectionId: string;
  provider: IntegrationProvider;
  projects: readonly ProviderProject[];
  fetchedAt: Date;
  pruneMissing?: boolean;
}): Promise<{ created: number; updated: number }> {
  const prisma = getPrisma();

  // Existing identifiers are read once: an upsert does not tell a creation from an
  // update, and the run history must distinguish them.
  const existing = new Set(
    (
      await prisma.projectSnapshot.findMany({
        where: { connectionId: input.connectionId },
        select: { externalId: true },
      })
    ).map((row) => row.externalId),
  );
  let created = 0;

  for (const project of input.projects) {
    if (!existing.has(project.externalId)) {
      created += 1;
    }
    await prisma.projectSnapshot.upsert({
      where: {
        connectionId_externalId: {
          connectionId: input.connectionId,
          externalId: project.externalId,
        },
      },
      create: {
        connectionId: input.connectionId,
        provider: input.provider,
        externalId: project.externalId,
        externalUrl: project.externalUrl,
        name: project.name,
        visibility: project.visibility,
        metrics: project.metrics as never,
        fetchedAt: input.fetchedAt,
      },
      update: {
        externalUrl: project.externalUrl,
        name: project.name,
        visibility: project.visibility,
        metrics: project.metrics as never,
        fetchedAt: input.fetchedAt,
      },
    });
  }

  if (input.pruneMissing) {
    await prisma.projectSnapshot.deleteMany({
      where: {
        connectionId: input.connectionId,
        externalId: { notIn: input.projects.map((project) => project.externalId) },
      },
    });
  }

  return { created, updated: input.projects.length - created };
}

export async function markSyncSuccess(
  connectionId: string,
  fetchedAt: Date,
): Promise<void> {
  await getPrisma().integrationConnection.update({
    where: { id: connectionId },
    data: { status: "CONNECTED", lastSyncedAt: fetchedAt, lastSyncError: null },
  });
}

/**
 * Records a failure while keeping the last successful time: the interface must
 * show "synchronisation failed", not an empty dashboard.
 */
export async function markSyncFailure(
  connectionId: string,
  safeMessage: string,
): Promise<void> {
  await getPrisma().integrationConnection.update({
    where: { id: connectionId },
    data: { status: "ERROR", lastSyncError: safeMessage },
  });
}

/**
 * One issue as the interface displays it. Never a provider payload.
 */
export type IssueSummary = {
  id: string;
  kind: IssueKind;
  provider: IntegrationProvider;
  /** Instance the issue comes from, so two connections stay distinguishable. */
  connectionLabel: string;
  repository: string;
  number: number;
  title: string;
  url: string;
  authorLogin: string | null;
  assignees: string[];
  milestone: string | null;
  commentsCount: number;
  labels: string[];
  openedAt: Date;
  activityAt: Date;
};

/**
 * Stores the open issues and pull requests of one synchronisation.
 *
 * Same idempotency rule as the project snapshots: upserting on
 * (connectionId, externalId) makes a re-run update rows instead of duplicating
 * them.
 *
 * Pruning is per repository (DA-04): an issue the provider no longer reports as open
 * is deleted from each repository **read in full this run** — a closed issue must
 * leave this list, which is what keeps it a to-do list and not an archive — and every
 * issue of a repository no longer tracked goes too. A repository answered 304, left
 * out by the bound or refused by the provider is not touched: its rows are either
 * current (304) or unknown, never "closed".
 */
export async function saveIssues(input: {
  connectionId: string;
  provider: IntegrationProvider;
  /** Issues of the repositories read in full. */
  issues: readonly ProviderIssue[];
  fetchedAt: Date;
  /** Repositories read in full this run (200): their missing issues are closed. */
  readRepositories: readonly string[];
  /** Every repository still tracked: issues of any other one are dropped. */
  trackedRepositories: readonly string[];
}): Promise<{ created: number; updated: number }> {
  const prisma = getPrisma();

  // Same counting rule as the project snapshots: creations and refreshes are told
  // apart so the run history can report both.
  const existing = new Set(
    (
      await prisma.issueSnapshot.findMany({
        where: { connectionId: input.connectionId },
        select: { externalId: true },
      })
    ).map((row) => row.externalId),
  );
  let created = 0;

  for (const issue of input.issues) {
    if (!existing.has(issue.externalId)) {
      created += 1;
    }
    const data = {
      provider: input.provider,
      kind: issue.kind,
      repository: issue.repository,
      number: issue.number,
      title: issue.title,
      url: issue.url,
      authorLogin: issue.authorLogin,
      assignees: issue.assignees,
      milestone: issue.milestone,
      commentsCount: issue.commentsCount,
      labels: issue.labels,
      openedAt: issue.openedAt,
      activityAt: issue.activityAt,
      fetchedAt: input.fetchedAt,
    };

    await prisma.issueSnapshot.upsert({
      where: {
        connectionId_externalId: {
          connectionId: input.connectionId,
          externalId: issue.externalId,
        },
      },
      create: { connectionId: input.connectionId, externalId: issue.externalId, ...data },
      update: data,
    });
  }

  await prisma.issueSnapshot.deleteMany({
    where: {
      connectionId: input.connectionId,
      OR: [
        {
          repository: { in: [...input.readRepositories] },
          externalId: { notIn: input.issues.map((issue) => issue.externalId) },
        },
        { repository: { notIn: [...input.trackedRepositories] } },
      ],
    },
  });

  return { created, updated: input.issues.length - created };
}

/**
 * Every open issue and pull request followed by this owner, newest first.
 *
 * Scoped through the connection, so a query can never return another owner's
 * issues. The volume is bounded by the synchronisation itself (the most recently
 * active repositories, a fixed page size per repository), which is why the whole
 * set is returned: the page computes its indicators on all of it and only the
 * table is truncated.
 */
export async function listIssues(workspaceId: string): Promise<IssueSummary[]> {
  const rows = await getPrisma().issueSnapshot.findMany({
    where: { connection: { workspaceId } },
    orderBy: [{ openedAt: "desc" }],
    select: {
      id: true,
      kind: true,
      provider: true,
      repository: true,
      number: true,
      title: true,
      url: true,
      authorLogin: true,
      assignees: true,
      milestone: true,
      commentsCount: true,
      labels: true,
      openedAt: true,
      activityAt: true,
      connection: { select: { instanceUrl: true } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    kind: row.kind as IssueKind,
    provider: row.provider as IntegrationProvider,
    connectionLabel: describeInstance(
      row.provider as IntegrationProvider,
      row.connection.instanceUrl,
    ),
    repository: row.repository,
    number: row.number,
    title: row.title,
    url: row.url,
    authorLogin: row.authorLogin,
    // A scalar list never comes back null: the column is NOT NULL with an empty array
    // as default, precisely so this cannot surprise a caller.
    assignees: row.assignees,
    milestone: row.milestone,
    commentsCount: row.commentsCount,
    labels: row.labels,
    openedAt: row.openedAt,
    activityAt: row.activityAt,
  }));
}

export type ProjectSummary = {
  connectionId: string;
  name: string;
  provider: IntegrationProvider;
  /** Link to the repository at the provider. */
  url: string;
  metrics: Record<string, unknown> | null;
};

/** Stored projects with the provider metrics the activity and health indicators read. */
export async function listProjects(userId: string): Promise<ProjectSummary[]> {
  const rows = await getPrisma().projectSnapshot.findMany({
    where: { connection: { userId } },
    orderBy: { name: "asc" },
    select: { name: true, provider: true, externalUrl: true, metrics: true, connectionId: true },
  });

  return rows.map((row) => ({
    connectionId: row.connectionId,
    name: row.name,
    provider: row.provider as IntegrationProvider,
    url: row.externalUrl,
    metrics:
      typeof row.metrics === "object" && row.metrics !== null && !Array.isArray(row.metrics)
        ? (row.metrics as Record<string, unknown>)
        : null,
  }));
}

/** One milestone as the interface displays it. */
export type MilestoneSummary = {
  id: string;
  repository: string;
  number: number;
  title: string;
  state: string;
  dueOn: Date | null;
  /** Provider counters: everything attached to the milestone, not only what is stored. */
  issuesOpen: number;
  issuesClosed: number;
  url: string;
  /** Open issues of this milestone that are followed here. */
  trackedIssues: number;
  /** Of those, how many have no assignee at all. */
  unassigned: number;
};

/**
 * Stores the milestones of one synchronisation.
 *
 * Same idempotency rule as everywhere else: upserting on (connectionId, externalId).
 * Pruning follows the issue rule, per repository read in full: it matters more here,
 * since a milestone deleted at the provider would otherwise linger forever with a due
 * date that no longer means anything.
 */
export async function saveMilestones(input: {
  connectionId: string;
  provider: IntegrationProvider;
  milestones: readonly ProviderMilestone[];
  fetchedAt: Date;
  readRepositories: readonly string[];
  trackedRepositories: readonly string[];
}): Promise<{ created: number; updated: number }> {
  const prisma = getPrisma();

  const existing = new Set(
    (
      await prisma.milestoneSnapshot.findMany({
        where: { connectionId: input.connectionId },
        select: { externalId: true },
      })
    ).map((row) => row.externalId),
  );
  let created = 0;

  for (const milestone of input.milestones) {
    if (!existing.has(milestone.externalId)) {
      created += 1;
    }
    const data = {
      provider: input.provider,
      repository: milestone.repository,
      number: milestone.number,
      title: milestone.title,
      state: milestone.state,
      dueOn: milestone.dueOn,
      issuesOpen: milestone.issuesOpen,
      issuesClosed: milestone.issuesClosed,
      url: milestone.url,
      fetchedAt: input.fetchedAt,
    };

    await prisma.milestoneSnapshot.upsert({
      where: {
        connectionId_externalId: {
          connectionId: input.connectionId,
          externalId: milestone.externalId,
        },
      },
      create: { connectionId: input.connectionId, externalId: milestone.externalId, ...data },
      update: data,
    });
  }

  await prisma.milestoneSnapshot.deleteMany({
    where: {
      connectionId: input.connectionId,
      OR: [
        {
          repository: { in: [...input.readRepositories] },
          externalId: { notIn: input.milestones.map((milestone) => milestone.externalId) },
        },
        { repository: { notIn: [...input.trackedRepositories] } },
      ],
    },
  });

  return { created, updated: input.milestones.length - created };
}

/**
 * Followed milestones of this owner, soonest due first.
 *
 * The `trackedIssues` and `unassigned` counts are computed here rather than in the
 * page: they come from the stored issues, so they are exact for what is displayed and
 * can be compared honestly with the provider's own counters.
 */
export async function listMilestones(workspaceId: string): Promise<MilestoneSummary[]> {
  const [rows, issues] = await Promise.all([
    getPrisma().milestoneSnapshot.findMany({
      where: { connection: { workspaceId } },
      select: {
        id: true,
        repository: true,
        number: true,
        title: true,
        state: true,
        dueOn: true,
        issuesOpen: true,
        issuesClosed: true,
        url: true,
      },
    }),
    getPrisma().issueSnapshot.findMany({
      where: { connection: { workspaceId } },
      select: { repository: true, milestone: true, assignees: true, kind: true },
    }),
  ]);

  return rows
    .map((row) => {
      const attached = issues.filter(
        (issue) => issue.milestone === row.title && issue.repository === row.repository,
      );

      return {
        id: row.id,
        repository: row.repository,
        number: row.number,
        title: row.title,
        state: row.state,
        dueOn: row.dueOn,
        issuesOpen: row.issuesOpen,
        issuesClosed: row.issuesClosed,
        url: row.url,
        trackedIssues: attached.length,
        unassigned: attached.filter(
          (issue) => issue.kind === "ISSUE" && issue.assignees.length === 0,
        ).length,
      };
    })
    .sort((left, right) => {
      if (left.dueOn && right.dueOn) {
        return left.dueOn.getTime() - right.dueOn.getTime();
      }
      // No due date sorts last: an undated milestone is not "due first".
      if (left.dueOn) return -1;
      if (right.dueOn) return 1;

      return left.title.localeCompare(right.title);
    });
}

/** Stored validators of one connection, as the synchronisation reads them (DA-04). */
export async function listCacheEntries(connectionId: string): Promise<CacheEntryLike[]> {
  return getPrisma().providerCacheEntry.findMany({
    where: { connectionId },
    select: {
      resource: true,
      etag: true,
      lastModified: true,
      checkedAt: true,
      changedAt: true,
    },
  });
}

/**
 * Records the resources checked by one run (DA-04), **after** their rows were saved:
 * a validator must never be stored ahead of the data it vouches for, so a run that
 * stops halfway leaves at worst an old validator for old rows, never a new one for
 * rows that were not written.
 *
 * A 304 only moves `checkedAt`. A full answer moves both instants and replaces the
 * validators — with `null` when it carried none, so a stale one is never kept. Entries
 * of repositories no longer tracked, and entries nobody checked within the maximum
 * age (a changed bound leaves its old keys behind), are dropped.
 */
export async function saveCacheChecks(input: {
  connectionId: string;
  kind: "issues" | "milestones";
  checks: readonly ResourceCheck[];
  trackedRepositories: readonly string[];
  checkedAt: Date;
}): Promise<void> {
  const prisma = getPrisma();

  for (const check of input.checks) {
    if (check.notModified) {
      await prisma.providerCacheEntry.updateMany({
        where: { connectionId: input.connectionId, resource: check.resource },
        data: { checkedAt: input.checkedAt },
      });
      continue;
    }

    const data = {
      kind: input.kind,
      repository: check.repository,
      etag: check.validator?.etag ?? null,
      lastModified: check.validator?.lastModified ?? null,
      checkedAt: input.checkedAt,
      changedAt: input.checkedAt,
    };

    await prisma.providerCacheEntry.upsert({
      where: {
        connectionId_resource: { connectionId: input.connectionId, resource: check.resource },
      },
      create: { connectionId: input.connectionId, resource: check.resource, ...data },
      update: data,
    });
  }

  await prisma.providerCacheEntry.deleteMany({
    where: {
      connectionId: input.connectionId,
      kind: input.kind,
      OR: [
        { repository: { notIn: [...input.trackedRepositories] } },
        {
          checkedAt: {
            lt: new Date(input.checkedAt.getTime() - CACHE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000),
          },
        },
      ],
    },
  });
}

/** One cache entry as the integrations page displays it. */
export type ProviderCacheSummary = {
  id: string;
  provider: IntegrationProvider;
  kind: string;
  repository: string;
  hasValidator: boolean;
  checkedAt: Date;
  changedAt: Date;
};

export async function listProviderCache(workspaceId: string): Promise<ProviderCacheSummary[]> {
  const rows = await getPrisma().providerCacheEntry.findMany({
    where: { connection: { workspaceId } },
    orderBy: [{ repository: "asc" }, { kind: "asc" }],
    select: {
      id: true,
      kind: true,
      repository: true,
      etag: true,
      lastModified: true,
      checkedAt: true,
      changedAt: true,
      connection: { select: { provider: true } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    provider: row.connection.provider as IntegrationProvider,
    kind: row.kind,
    repository: row.repository,
    hasValidator: Boolean(row.etag || row.lastModified),
    checkedAt: row.checkedAt,
    changedAt: row.changedAt,
  }));
}

/**
 * Stores the CI runs of one synchronisation (DA-03).
 *
 * The table holds current state, bounded by construction (repositories read × one
 * page): for every repository read, the runs it returned replace the previous ones;
 * for a refused repository, its runs are dropped and the refusal is recorded on the
 * project, so the interface shows "unavailable" rather than outdated results. Runs of
 * repositories that are no longer tracked are dropped too. A repository left out by
 * the bound keeps its last read, displayed with its date.
 */
export async function saveCiRuns(input: {
  connectionId: string;
  provider: IntegrationProvider;
  results: readonly CiRepositoryResult[];
  /** Names of every project of this run, to drop runs of untracked repositories. */
  trackedRepositories: readonly string[];
  fetchedAt: Date;
}): Promise<{ created: number; updated: number }> {
  const prisma = getPrisma();

  const existing = new Set(
    (
      await prisma.ciRunSnapshot.findMany({
        where: { connectionId: input.connectionId },
        select: { externalId: true },
      })
    ).map((row) => row.externalId),
  );
  let created = 0;
  let saved = 0;

  for (const result of input.results) {
    const runs = result.read ? result.runs : [];

    for (const run of runs) {
      if (!existing.has(run.externalId)) {
        created += 1;
      }
      saved += 1;
      const data = {
        provider: input.provider,
        repository: run.repository,
        workflowName: run.workflowName,
        branch: run.branch,
        status: run.status,
        conclusion: run.conclusion,
        url: run.url,
        startedAt: run.startedAt,
        runUpdatedAt: run.updatedAt,
        fetchedAt: input.fetchedAt,
      };

      await prisma.ciRunSnapshot.upsert({
        where: {
          connectionId_externalId: {
            connectionId: input.connectionId,
            externalId: run.externalId,
          },
        },
        create: { connectionId: input.connectionId, externalId: run.externalId, ...data },
        update: data,
      });
    }

    await prisma.ciRunSnapshot.deleteMany({
      where: {
        connectionId: input.connectionId,
        repository: result.repository,
        externalId: { notIn: runs.map((run) => run.externalId) },
      },
    });
    await prisma.projectSnapshot.updateMany({
      where: { connectionId: input.connectionId, name: result.repository },
      data: {
        ciCheckedAt: input.fetchedAt,
        ciError: result.read ? null : result.errorCode,
      },
    });
  }

  await prisma.ciRunSnapshot.deleteMany({
    where: {
      connectionId: input.connectionId,
      repository: { notIn: [...input.trackedRepositories] },
    },
  });

  return { created, updated: saved - created };
}

/** CI state of every stored project, as the CI card reads it (DA-03). */
export type CiRepositorySummary = {
  repository: string;
  provider: IntegrationProvider;
  url: string;
  ciCheckedAt: Date | null;
  ciError: string | null;
  runs: CiRunSummary[];
};

export type CiRunSummary = {
  id: string;
  repository: string;
  workflowName: string;
  branch: string | null;
  status: string;
  conclusion: string | null;
  url: string;
  startedAt: Date;
  runUpdatedAt: Date;
};

export async function listCiRepositories(userId: string): Promise<CiRepositorySummary[]> {
  const [projects, runs] = await Promise.all([
    getPrisma().projectSnapshot.findMany({
      where: { connection: { userId } },
      orderBy: { name: "asc" },
      select: {
        name: true,
        provider: true,
        externalUrl: true,
        ciCheckedAt: true,
        ciError: true,
        connectionId: true,
      },
    }),
    getPrisma().ciRunSnapshot.findMany({
      where: { connection: { userId } },
      orderBy: { startedAt: "desc" },
      select: {
        id: true,
        connectionId: true,
        repository: true,
        workflowName: true,
        branch: true,
        status: true,
        conclusion: true,
        url: true,
        startedAt: true,
        runUpdatedAt: true,
      },
    }),
  ]);

  return projects.map((project) => ({
    repository: project.name,
    provider: project.provider as IntegrationProvider,
    url: project.externalUrl,
    ciCheckedAt: project.ciCheckedAt,
    ciError: project.ciError,
    runs: runs
      .filter(
        (run) =>
          run.connectionId === project.connectionId && run.repository === project.name,
      )
      .map((run) => ({
        id: run.id,
        repository: run.repository,
        workflowName: run.workflowName,
        branch: run.branch,
        status: run.status,
        conclusion: run.conclusion,
        url: run.url,
        startedAt: run.startedAt,
        runUpdatedAt: run.runUpdatedAt,
      })),
  }));
}

/** Opens a run before the first provider request. */
export async function startSyncRun(connectionId: string): Promise<string> {
  const run = await getPrisma().syncRun.create({
    data: { connectionId },
    select: { id: true },
  });

  return run.id;
}

/**
 * Closes a run with its final status and counters. The caller closes it on success,
 * on partial completion and on failure alike: a run must never stay `RUNNING`
 * because the process forgot about it.
 */
export async function finishSyncRun(
  runId: string,
  input: {
    status: SyncRunStatus;
    fetched: number;
    created: number;
    updated: number;
    skipped: number;
    failed: number;
    retries: number;
    errorSummary?: string | null;
  },
): Promise<void> {
  await getPrisma().syncRun.update({
    where: { id: runId },
    data: {
      status: input.status,
      finishedAt: new Date(),
      fetched: input.fetched,
      created: input.created,
      updated: input.updated,
      skipped: input.skipped,
      failed: input.failed,
      retries: input.retries,
      errorSummary: input.errorSummary ?? null,
    },
  });
}

/**
 * Recent runs of this owner, newest first, with the connection they belong to.
 * Bounded by `limit`: the page reads one page of history, not the whole table.
 */
export async function listSyncRuns(
  workspaceId: string,
  limit = 50,
): Promise<SyncRunSummary[]> {
  const rows = await getPrisma().syncRun.findMany({
    where: { connection: { workspaceId } },
    orderBy: { startedAt: "desc" },
    take: limit,
    select: {
      id: true,
      connectionId: true,
      status: true,
      startedAt: true,
      finishedAt: true,
      fetched: true,
      created: true,
      updated: true,
      skipped: true,
      failed: true,
      retries: true,
      errorSummary: true,
      connection: { select: { provider: true, instanceUrl: true } },
    },
  });

  return rows.map((row) => {
    const provider = row.connection.provider as IntegrationProvider;

    return {
      id: row.id,
      connectionId: row.connectionId,
      provider,
      connectionLabel: describeInstance(provider, row.connection.instanceUrl),
      status: row.status as SyncRunStatus,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      fetched: row.fetched,
      created: row.created,
      updated: row.updated,
      skipped: row.skipped,
      failed: row.failed,
      retries: row.retries,
      errorSummary: row.errorSummary,
    };
  });
}

/**
 * Retention: deletes runs older than the cutoff, except the most recent successful
 * run of each connection — the freshness of the last success must survive even a
 * long pause. Owner-scoped like every other read: a run is reachable only through
 * the owner's connections. Bounded by the cutoff and safe to re-run.
 */
export async function pruneSyncRuns(input: {
  workspaceId: string;
  olderThan: Date;
}): Promise<number> {
  const prisma = getPrisma();

  const successes = await prisma.syncRun.findMany({
    where: { connection: { workspaceId: input.workspaceId }, status: "SUCCESS" },
    orderBy: { startedAt: "desc" },
    select: { id: true, connectionId: true },
  });

  const retainedConnections = new Set<string>();
  const keptIds: string[] = [];
  for (const run of successes) {
    if (!retainedConnections.has(run.connectionId)) {
      retainedConnections.add(run.connectionId);
      keptIds.push(run.id);
    }
  }

  const deleted = await prisma.syncRun.deleteMany({
    where: {
      connection: { workspaceId: input.workspaceId },
      startedAt: { lt: input.olderThan },
      // An empty list means no successful run exists yet: nothing to protect.
      ...(keptIds.length > 0 ? { id: { notIn: keptIds } } : {}),
    },
  });

  return deleted.count;
}

/* Delivery history (M14-02). */

/**
 * Stores the delivery data of the repositories read this run. Idempotent: pull
 * requests, releases and deployments are keyed by `(connection, externalId)`, and a
 * pull request's children are replaced together with it in one transaction, so a
 * re-sync never duplicates a file, review, commit or link. Nothing is pruned here:
 * this is history, bounded by `pruneDeliveryHistory`. A refused repository writes
 * nothing, so its earlier history stays as it was.
 */
export async function saveDelivery(input: {
  connectionId: string;
  provider: IntegrationProvider;
  results: readonly DeliveryRepositoryResult[];
  fetchedAt: Date;
}): Promise<{ created: number; updated: number }> {
  const prisma = getPrisma();
  const read = input.results.filter(
    (result): result is Extract<DeliveryRepositoryResult, { read: true }> => result.read,
  );
  const ids = (key: "pullRequests" | "releases" | "deployments") =>
    read.flatMap((result) => result[key].map((item) => item.externalId));

  const [knownPullRequests, knownReleases, knownDeployments] = await Promise.all([
    prisma.pullRequestSnapshot.findMany({
      where: { connectionId: input.connectionId, externalId: { in: ids("pullRequests") } },
      select: { externalId: true },
    }),
    prisma.releaseSnapshot.findMany({
      where: { connectionId: input.connectionId, externalId: { in: ids("releases") } },
      select: { externalId: true },
    }),
    prisma.deploymentSnapshot.findMany({
      where: { connectionId: input.connectionId, externalId: { in: ids("deployments") } },
      select: { externalId: true },
    }),
  ]);
  const known = new Set(
    [...knownPullRequests, ...knownReleases, ...knownDeployments].map((row) => row.externalId),
  );
  let created = 0;
  let saved = 0;
  const tally = (externalId: string) => {
    saved += 1;
    if (!known.has(externalId)) created += 1;
  };

  for (const result of read) {
    for (const pr of result.pullRequests) {
      tally(pr.externalId);
      const data = {
        provider: input.provider,
        repository: pr.repository,
        number: pr.number,
        title: pr.title,
        url: pr.url,
        authorLogin: pr.authorLogin,
        state: pr.state,
        isDraft: pr.isDraft,
        baseBranch: pr.baseBranch,
        headBranch: pr.headBranch,
        additions: pr.additions,
        deletions: pr.deletions,
        changedFiles: pr.changedFiles,
        commitsCount: pr.commitsCount,
        commentsCount: pr.commentsCount,
        reviewsCount: pr.reviewsCount,
        openedAt: pr.openedAt,
        closedAt: pr.closedAt,
        mergedAt: pr.mergedAt,
        firstReviewAt: firstInstant(pr.reviews.map((review) => review.submittedAt)),
        providerUpdatedAt: pr.updatedAt,
        childrenTruncated: pr.childrenTruncated,
        fetchedAt: input.fetchedAt,
      };

      await prisma.$transaction(async (tx) => {
        const row = await tx.pullRequestSnapshot.upsert({
          where: { connectionId_externalId: { connectionId: input.connectionId, externalId: pr.externalId } },
          create: { connectionId: input.connectionId, externalId: pr.externalId, ...data },
          update: data,
          select: { id: true },
        });
        const pullRequestId = row.id;

        await tx.pullRequestFile.deleteMany({ where: { pullRequestId } });
        await tx.pullRequestReview.deleteMany({ where: { pullRequestId } });
        await tx.pullRequestCommit.deleteMany({ where: { pullRequestId } });
        await tx.pullRequestIssueLink.deleteMany({ where: { pullRequestId } });
        await tx.pullRequestFile.createMany({
          data: pr.files.map((file) => ({ pullRequestId, ...file })),
          skipDuplicates: true,
        });
        await tx.pullRequestReview.createMany({
          data: pr.reviews.map((review) => ({ pullRequestId, ...review })),
          skipDuplicates: true,
        });
        await tx.pullRequestCommit.createMany({
          data: pr.commits.map((commit) => ({ pullRequestId, ...commit })),
          skipDuplicates: true,
        });
        await tx.pullRequestIssueLink.createMany({
          data: pr.issueLinks.map((link) => ({ pullRequestId, ...link })),
          skipDuplicates: true,
        });
      });
    }

    for (const release of result.releases) {
      tally(release.externalId);
      const { externalId, ...data } = release;
      await prisma.releaseSnapshot.upsert({
        where: { connectionId_externalId: { connectionId: input.connectionId, externalId } },
        create: { connectionId: input.connectionId, externalId, provider: input.provider, ...data, fetchedAt: input.fetchedAt },
        update: { ...data, fetchedAt: input.fetchedAt },
      });
    }

    for (const deployment of result.deployments) {
      tally(deployment.externalId);
      const { externalId, ...data } = deployment;
      await prisma.deploymentSnapshot.upsert({
        where: { connectionId_externalId: { connectionId: input.connectionId, externalId } },
        create: { connectionId: input.connectionId, externalId, provider: input.provider, ...data, fetchedAt: input.fetchedAt },
        update: { ...data, fetchedAt: input.fetchedAt },
      });
    }
  }

  return { created, updated: saved - created };
}

function firstInstant(values: readonly (Date | null)[]): Date | null {
  const times = values.filter((value): value is Date => value !== null).map((value) => value.getTime());
  return times.length === 0 ? null : new Date(Math.min(...times));
}

/**
 * Deletes delivery history older than the cutoff, workspace by workspace: pull
 * requests by their last provider update (children cascade), releases and
 * deployments by their creation. Bounded by the cutoff and safe to re-run.
 */
export async function pruneDeliveryHistory(input: {
  workspaceId: string;
  olderThan: Date;
}): Promise<number> {
  const prisma = getPrisma();
  const connection = { workspaceId: input.workspaceId };
  const [pullRequests, releases, deployments] = await Promise.all([
    prisma.pullRequestSnapshot.deleteMany({ where: { connection, providerUpdatedAt: { lt: input.olderThan } } }),
    prisma.releaseSnapshot.deleteMany({ where: { connection, releasedAt: { lt: input.olderThan } } }),
    prisma.deploymentSnapshot.deleteMany({ where: { connection, deployedAt: { lt: input.olderThan } } }),
  ]);

  return pullRequests.count + releases.count + deployments.count;
}
