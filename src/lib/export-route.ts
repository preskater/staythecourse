import { requireApiAccess, moduleUnavailableResponse } from "@/lib/auth/guard";
import { createCsvResponse } from "@/lib/csv";
import {
  buildExport,
  EXPORT_ENTITIES,
  EXPORT_MODULES,
  ExportFilterError,
  type ExportEntity,
} from "@/lib/exports";
import type { SessionUser } from "@/lib/auth/guard";
import { hasModule } from "@/modules/catalog/catalog";
import { recordAuditEvent } from "@/modules/audit/repository";
import type { AuditAction } from "@/modules/audit/domain";

/**
 * The one path every CSV export takes.
 *
 * Both entry points — the per-entity Route Handlers and the umbrella
 * `/api/export?entity=...` — end up here, in this order:
 *
 * 1. `requireApiAccess("export", …)`: a signed-out request answers 401, a module that is
 *    not active in the workspace answers 404, and a role without the `export`
 *    permission answers 403. Nothing is read in any of those cases;
 * 2. the builder reads, owner-scoped, bounded, and never trusts an identifier from the
 *    query string;
 * 3. the audit entry is written (SO-02) — a failure refuses the file. Writing the entry
 *    after the read but before the response is deliberate: an export the trail does not
 *    know about is worse than an export delayed by a database error;
 * 4. `createCsvResponse` sets `no-store` and the truncation header, and `toCsv` has
 *    already neutralised every formula-shaped cell.
 *
 * The owner always comes from the session, never from a parameter: there is no `userId`
 * or `workspaceId` a caller could substitute.
 */

const EXPORT_ACTIONS: Record<ExportEntity, AuditAction> = {
  transactions: "export.transactions",
  properties: "export.properties",
  budgets: "export.budgets",
  goals: "export.goals",
  alerts: "export.alerts",
};

/** 400 for a filter the caller can fix, instead of a silently different file. */
export function invalidExportFilterResponse(error: ExportFilterError): Response {
  return Response.json(
    { error: "invalid_export_filter", parameter: error.parameter, code: error.code },
    { status: 400, headers: { "Cache-Control": "no-store" } },
  );
}

/** 400 for a missing or unknown `entity`, naming the supported ones. */
export function unknownEntityResponse(): Response {
  return Response.json(
    { error: "unknown_entity", entities: EXPORT_ENTITIES },
    { status: 400, headers: { "Cache-Control": "no-store" } },
  );
}

/** 500 when the trail cannot be written: the file is withheld rather than unaudited. */
export function auditUnavailableResponse(): Response {
  return Response.json(
    { error: "audit_unavailable" },
    { status: 500, headers: { "Cache-Control": "no-store" } },
  );
}

/** Delivers one export for an already-authenticated user. */
export async function serveEntityExport(
  user: SessionUser,
  request: Request,
  entity: ExportEntity,
): Promise<Response> {
  const moduleKey = EXPORT_MODULES[entity];
  if (moduleKey !== null && !hasModule(user.workspace, moduleKey)) {
    return moduleUnavailableResponse();
  }

  let file;
  try {
    file = await buildExport(entity, user.workspace, new URL(request.url).searchParams);
  } catch (error) {
    if (error instanceof ExportFilterError) {
      return invalidExportFilterResponse(error);
    }
    throw error;
  }

  try {
    await recordAuditEvent({
      workspaceId: user.workspace.id,
      actorId: user.id,
      action: EXPORT_ACTIONS[entity],
      entityType: "EXPORT",
      outcome: "SUCCESS",
      metadata: {
        entity,
        scope: file.scope,
        from: file.from,
        to: file.to,
        rows: file.rowCount,
        truncated: file.truncated,
      },
    });
  } catch {
    return auditUnavailableResponse();
  }

  return createCsvResponse(file.csv, file.fileName, { truncated: file.truncated });
}

/** Entry point of a per-entity Route Handler: checks the session and role, then delegates. */
export async function serveCsvExport(
  request: Request,
  entity: ExportEntity,
): Promise<Response> {
  const moduleKey = EXPORT_MODULES[entity];
  const user = moduleKey
    ? await requireApiAccess("export", moduleKey)
    : await requireApiAccess("export");

  if (user instanceof Response) {
    return user;
  }

  return serveEntityExport(user, request, entity);
}
