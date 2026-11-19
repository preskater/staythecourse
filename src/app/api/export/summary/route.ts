import { requireApiAccess } from "@/lib/auth/guard";
import { auditUnavailableResponse } from "@/lib/export-route";
import { createMarkdownResponse } from "@/lib/markdown";
import { recordAuditEvent } from "@/modules/audit/repository";
import {
  parseSummaryParams,
  readSituationSummary,
  SummaryFilterError,
} from "@/modules/dashboard/summary";
import { renderSituationSummary } from "@/modules/dashboard/summary-markdown";

/**
 * Global situation summary, as one Markdown file.
 *
 * Unlike the CSV exports this document spans several modules, so it is not bound to a
 * single one: the `export` permission is required, and each section is read only when its
 * module is active in the workspace (the document says which sections are absent and
 * why). Nothing is cached and nothing is written except the audit entry.
 *
 * Filters: `?scope=all|finance` (default `all`), `?month=YYYY-MM` (default current, a
 * malformed value falls back like the budgets export), `?horizon=1..12` (months after the
 * reference month, default 6). An unknown scope or an out-of-range horizon answers 400
 * before any read, rather than describing a different document than the one asked for.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const user = await requireApiAccess("export");

  if (user instanceof Response) {
    return user;
  }

  let summary;
  try {
    summary = await readSituationSummary({
      workspace: user.workspace,
      params: parseSummaryParams(new URL(request.url).searchParams),
    });
  } catch (error) {
    if (error instanceof SummaryFilterError) {
      return Response.json(
        {
          error: "invalid_export_filter",
          parameter: error.parameter,
          code: error.code,
        },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }
    throw error;
  }

  // The trail names the perimeter and the reference month, never an amount or a label.
  try {
    await recordAuditEvent({
      workspaceId: user.workspace.id,
      actorId: user.id,
      action: "export.summary",
      entityType: "EXPORT",
      outcome: "SUCCESS",
      metadata: {
        entity: "summary",
        scope: summary.scope,
        month: summary.monthKey,
        horizon: summary.horizon,
        sections: summary.sections.filter((section) => section.included).length,
        truncated: summary.truncated.length > 0,
      },
    });
  } catch {
    return auditUnavailableResponse();
  }

  return createMarkdownResponse(
    renderSituationSummary(summary),
    `synthese-${summary.monthKey}.md`,
    { truncated: summary.truncated.length > 0 },
  );
}
