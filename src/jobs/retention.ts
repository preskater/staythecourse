import { getPrisma } from "@/lib/db";
import { AUDIT_RETENTION_DAYS } from "@/modules/audit/domain";
import { pruneDeliveryHistory, pruneSyncRuns } from "@/modules/integrations/repository";

// Re-exported for the operator script and the page: the constant lives in the audit
// domain so reading it never pulls the database client into a caller.
export { AUDIT_RETENTION_DAYS };

/**
 * Retention of synchronisation history.
 *
 * Provider snapshots are current state, not history: a run replaces them, and issue
 * pruning already removes what the provider no longer reports as open. What grows
 * without bound is the run history, so that is what this policy bounds.
 *
 * The cleanup is run deliberately — by the owner or by an external scheduler — and
 * never from the web process. It is workspace-scoped, bounded by the cutoff and safe to
 * re-run; the most recent successful run of each connection is always kept, so the
 * freshness display survives a long pause.
 */
export const SYNC_RUN_RETENTION_DAYS = 90;

export function retentionCutoff(
  now: Date,
  retentionDays: number = SYNC_RUN_RETENTION_DAYS,
): Date {
  return new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
}

export async function cleanUpSyncRuns(
  options: { now?: Date; retentionDays?: number } = {},
): Promise<{ workspaces: number; deleted: number }> {
  const now = options.now ?? new Date();
  const olderThan = retentionCutoff(now, options.retentionDays);

  const workspaces = await getPrisma().workspace.findMany({ select: { id: true } });

  let deleted = 0;
  for (const workspace of workspaces) {
    deleted += await pruneSyncRuns({ workspaceId: workspace.id, olderThan });
  }

  return { workspaces: workspaces.length, deleted };
}

/**
 * Deletes audit entries older than the retention window, workspace by workspace.
 *
 * This is the only deletion path for `AuditEvent`: the module has no update and no
 * delete, and no page or Server Action can reach this function. The workspace filter
 * keeps the cleanup owner-scoped, and the cutoff is applied to `createdAt` only.
 */
export async function cleanUpAuditEvents(
  options: { now?: Date; retentionDays?: number } = {},
): Promise<{ workspaces: number; deleted: number }> {
  const now = options.now ?? new Date();
  const olderThan = retentionCutoff(now, options.retentionDays ?? AUDIT_RETENTION_DAYS);
  const prisma = getPrisma();

  const workspaces = await prisma.workspace.findMany({ select: { id: true } });

  let deleted = 0;
  for (const workspace of workspaces) {
    const result = await prisma.auditEvent.deleteMany({
      where: { workspaceId: workspace.id, createdAt: { lt: olderThan } },
    });
    deleted += result.count;
  }

  return { workspaces: workspaces.length, deleted };
}

/**
 * Delivery history (M14-02) is history, not current state: 13 months covers a year of
 * comparisons plus the month in progress. Pull requests are aged by their last update
 * at the provider, releases and deployments by their creation.
 */
export const DELIVERY_RETENTION_DAYS = 395;

export async function cleanUpDeliveryHistory(
  options: { now?: Date; retentionDays?: number } = {},
): Promise<{ workspaces: number; deleted: number }> {
  const now = options.now ?? new Date();
  const olderThan = retentionCutoff(now, options.retentionDays ?? DELIVERY_RETENTION_DAYS);
  const workspaces = await getPrisma().workspace.findMany({ select: { id: true } });

  let deleted = 0;
  for (const workspace of workspaces) {
    deleted += await pruneDeliveryHistory({ workspaceId: workspace.id, olderThan });
  }

  return { workspaces: workspaces.length, deleted };
}
