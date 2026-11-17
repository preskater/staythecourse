import "dotenv/config";
import {
  AUDIT_RETENTION_DAYS,
  cleanUpAuditEvents,
  cleanUpSyncRuns,
  SYNC_RUN_RETENTION_DAYS,
} from "../src/jobs/retention";

/**
 * Bounded cleanup of synchronisation history and the audit trail.
 *
 * Run it from a workstation (`npm run db:cleanup`) or from the database tooling
 * image (`docker compose --profile full run --rm migrate npm run db:cleanup`).
 * Nothing schedules it on purpose: a cleanup is an operator decision, like every
 * other deferred job of this repository.
 *
 * Only rows older than their retention period are deleted. The most recent
 * successful run of each connection is always kept, and the audit cleanup is the
 * only deletion path for `AuditEvent` (365 days by default).
 */
async function main(): Promise<void> {
  const sync = await cleanUpSyncRuns();
  const audit = await cleanUpAuditEvents();

  console.log(
    `Synchronisation history: ${sync.deleted} run(s) deleted for ${sync.workspaces} workspace(s) (retention: ${SYNC_RUN_RETENTION_DAYS} days).`,
  );
  console.log(
    `Audit trail: ${audit.deleted} event(s) deleted for ${audit.workspaces} workspace(s) (retention: ${AUDIT_RETENTION_DAYS} days).`,
  );
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => {
    // Nothing to close explicitly: the Prisma client is released with the process.
  });
