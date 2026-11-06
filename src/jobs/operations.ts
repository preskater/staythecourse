import { getPrisma } from "@/lib/db";
import { recordAuditEvent } from "@/modules/audit/repository";
import type { AuditOutcome } from "@/modules/audit/domain";

/**
 * Operator procedures (backup, restore) recorded in the trail.
 *
 * The shell scripts in `infra/backups/` must keep working without Node installed, so
 * they do not call this module. The documented procedure runs
 * `npm run audit:operation -- <action> <outcome>` right after a successful step, which
 * writes the one safe row: an action code, an outcome and counts — never a dump name,
 * a database name or a path from the host.
 *
 * `actorId` is null on purpose: the operator is not a web session, and this deployment
 * has a single owner whose workspace the command resolves.
 */
export const OPERATION_ACTIONS = ["backup.run", "restore.run"] as const;

export type OperationAction = (typeof OPERATION_ACTIONS)[number];

export function isOperationAction(value: unknown): value is OperationAction {
  return typeof value === "string" && (OPERATION_ACTIONS as readonly string[]).includes(value);
}

/**
 * The workspace an operator command writes to.
 *
 * This repository is a single-owner deployment: one workspace is the normal case, and
 * several would make the choice ambiguous rather than guessable. `AUDIT_WORKSPACE_ID`
 * is the explicit escape hatch, and the error says how to use it.
 */
export async function resolveOperatorWorkspaceId(): Promise<string> {
  const configured = process.env.AUDIT_WORKSPACE_ID;
  if (configured) return configured;

  const workspaces = await getPrisma().workspace.findMany({
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 2,
    select: { id: true },
  });

  if (workspaces.length === 0) {
    throw new Error("No workspace exists yet: seed the owner before recording an operation.");
  }
  if (workspaces.length > 1) {
    throw new Error(
      "Several workspaces exist: set AUDIT_WORKSPACE_ID to the one the operation concerns.",
    );
  }

  return workspaces[0].id;
}

export async function recordOperationAudit(input: {
  action: OperationAction;
  outcome: AuditOutcome;
  workspaceId?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const workspaceId = input.workspaceId ?? (await resolveOperatorWorkspaceId());

  await recordAuditEvent({
    workspaceId,
    actorId: null,
    action: input.action,
    entityType: "OPERATION",
    outcome: input.outcome,
    metadata: input.metadata,
  });
}
