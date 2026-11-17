import "dotenv/config";
import { isAuditOutcome } from "../src/modules/audit/domain";
import {
  isOperationAction,
  recordOperationAudit,
  resolveOperatorWorkspaceId,
} from "../src/jobs/operations";

/**
 * Records one operator procedure in the append-only trail.
 *
 * Usage:
 *   npm run audit:operation -- backup.run SUCCESS
 *   npm run audit:operation -- restore.run SUCCESS
 *   npm run audit:operation -- backup.run FAILED
 *
 * Run it after `infra/backups/backup.sh` or `infra/backups/restore.sh` succeeded (or
 * knew it failed): the scripts stay usable without Node, and this command is the one
 * write path into `AuditEvent`. No dump name, host path or database name is accepted:
 * the arguments are codes only.
 */
async function main(): Promise<void> {
  const [action, outcome = "SUCCESS"] = process.argv.slice(2);

  if (!isOperationAction(action) || !isAuditOutcome(outcome)) {
    throw new Error(
      "usage: npm run audit:operation -- <backup.run|restore.run> <SUCCESS|REFUSED|FAILED>",
    );
  }

  const workspaceId = await resolveOperatorWorkspaceId();
  await recordOperationAudit({ action, outcome, workspaceId });

  console.log(`Audit: ${action} ${outcome} recorded for workspace ${workspaceId}.`);
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => {
    // The Prisma client is released with the process.
  });
