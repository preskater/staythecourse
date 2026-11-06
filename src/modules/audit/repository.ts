import { getPrisma } from "@/lib/db";
import {
  looksLikeCredential,
  redactAuditMetadata,
  type AuditAction,
  type AuditEntityType,
  type AuditMetadata,
  type AuditOutcome,
} from "./domain";

/**
 * Audit persistence (SO-02 / M18-02).
 *
 * There is no update and no delete in this module: a row is written once, by the
 * server, from a code the server chose. Retention is the only deletion path, and it
 * lives in the operator job (`src/jobs/retention.ts`) rather than here. Nothing in
 * `src/` exposes a write to the browser, which is what makes the trail append-only in
 * practice rather than by convention.
 */

export type AuditEntryInput = {
  workspaceId: string;
  /** Signed-in user, or `null` for a job or a scheduler. */
  actorId: string | null;
  action: AuditAction;
  entityType: AuditEntityType;
  entityId?: string | null;
  outcome: AuditOutcome;
  /** Free-form on the way in; `redactAuditMetadata` decides what is actually kept. */
  metadata?: Record<string, unknown>;
};

/** Maximum number of rows one page shows; keeps a long trail readable and bounded. */
export const AUDIT_EVENT_PAGE_SIZE = 100;

const SAFE_ENTITY_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,63}$/;

/**
 * An entity identifier is a reference, not a place for free text. A value that does
 * not look like an identifier is dropped rather than stored, exactly as metadata
 * values are: the trail must never become a copy of the row it describes.
 */
function safeEntityId(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (looksLikeCredential(value)) return null;
  return SAFE_ENTITY_ID.test(value) ? value : null;
}

/**
 * Writes one audit entry, scoped to its workspace.
 *
 * A failure propagates on purpose: the caller decides whether the action may proceed
 * unaudited. Exports treat it as fatal (see `serveCsvExport`), so a file never leaves
 * without its entry. A writer that has already changed data uses
 * `recordAuditEventSafely` instead, so a trail outage never disguises a committed
 * change as a failure.
 */
export async function recordAuditEvent(input: AuditEntryInput): Promise<void> {
  await getPrisma().auditEvent.create({
    data: {
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      action: input.action,
      entityType: input.entityType,
      entityId: safeEntityId(input.entityId),
      outcome: input.outcome,
      metadata: redactAuditMetadata(input.metadata),
    },
    select: { id: true },
  });
}

/**
 * Best-effort variant for a change that has already been written.
 *
 * Swallowing the error is deliberate: the ledger row exists, so answering "failed"
 * would invite the owner to repeat an operation that already happened. The log line
 * carries the error type only — never a payload, an amount or a secret.
 */
export async function recordAuditEventSafely(input: AuditEntryInput): Promise<void> {
  try {
    await recordAuditEvent(input);
  } catch (error) {
    console.error(`[audit] ${error instanceof Error ? error.name : typeof error}`);
  }
}

export type AuditEventRecord = {
  id: string;
  createdAt: Date;
  action: AuditAction;
  entityType: AuditEntityType;
  entityId: string | null;
  outcome: AuditOutcome;
  actorId: string | null;
  metadata: AuditMetadata;
};

/**
 * Reads one page of the trail for a workspace, most recent first.
 *
 * The workspace filter is the authorisation boundary: a caller cannot ask for another
 * workspace's entries, and there is no query that returns rows across workspaces.
 */
export async function listAuditEvents(
  workspaceId: string,
  options: { action?: AuditAction | null; take?: number } = {},
): Promise<AuditEventRecord[]> {
  const take = Math.min(
    Math.max(options.take ?? AUDIT_EVENT_PAGE_SIZE, 1),
    AUDIT_EVENT_PAGE_SIZE,
  );

  const rows = await getPrisma().auditEvent.findMany({
    where: {
      workspaceId,
      ...(options.action ? { action: options.action } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take,
    select: {
      id: true,
      createdAt: true,
      action: true,
      entityType: true,
      entityId: true,
      outcome: true,
      actorId: true,
      metadata: true,
    },
  });

  return rows.map((row) => ({
    ...row,
    action: row.action as AuditAction,
    entityType: row.entityType as AuditEntityType,
    outcome: row.outcome as AuditOutcome,
    metadata: (row.metadata ?? {}) as AuditMetadata,
  }));
}
