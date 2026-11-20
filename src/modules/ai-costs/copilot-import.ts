import { recordAuditEventSafely } from "@/modules/audit/repository";
import { ProviderError } from "@/modules/integrations/adapter";
import type { AiPageRequest, AiPageStop } from "@/modules/integrations/ai-adapter";
import { listCopilotDays, readCopilotSeats } from "@/modules/integrations/copilot";
import { copilotSeatStatus, type CopilotSeatStatus } from "./copilot";
import { upsertCopilotDays, upsertCopilotSeats } from "./copilot.repository";

/**
 * Imports one window of GitHub Copilot activity and today's seat breakdown (M11-08),
 * server-side only. Re-runnable: both writes are upserts keyed by organization and
 * day. The audit entry carries counts and codes only, never a figure per member.
 *
 * The token arrives in `request.token` and the organization in `request.scopeId`;
 * storing the token encrypted is M11-05.
 */

export type CopilotImportResult = {
  daysImported: number;
  seatStatus: CopilotSeatStatus;
  /** Where the next run resumes; `null` once the window is fully read. */
  nextCursor: string | null;
  stoppedBy: AiPageStop | null;
};

type Dependencies = {
  readSeats: typeof readCopilotSeats;
  listDays: typeof listCopilotDays;
  now: () => Date;
};

const DEFAULT_DEPENDENCIES: Dependencies = {
  readSeats: readCopilotSeats,
  listDays: listCopilotDays,
  now: () => new Date(),
};

export async function importCopilotUsage(
  input: {
    workspaceId: string;
    /** Signed-in owner, or `null` for a scheduled job. */
    actorId: string | null;
    connectionKey: string;
    request: AiPageRequest;
  },
  dependencies: Partial<Dependencies> = {},
): Promise<CopilotImportResult> {
  const { readSeats, listDays, now } = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  const audit = (outcome: "SUCCESS" | "FAILED", metadata: Record<string, string | number>) =>
    recordAuditEventSafely({
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      action: "integration.sync",
      entityType: "INTEGRATION",
      entityId: input.connectionKey,
      outcome,
      metadata: { provider: "GITHUB_COPILOT", kind: "ai_usage", ...metadata },
    });

  try {
    const fetchedAt = now();
    const seats = await readSeats(input.request);
    await upsertCopilotSeats(input.workspaceId, { connectionKey: input.connectionKey, seats, fetchedAt });

    const outcome = await listDays(input.request);
    const daysImported = await upsertCopilotDays(input.workspaceId, {
      connectionKey: input.connectionKey,
      days: outcome.records,
      fetchedAt,
    });
    const seatStatus = copilotSeatStatus(seats);

    await audit("SUCCESS", {
      days: daysImported,
      pages: outcome.pagesRead,
      stoppedBy: outcome.stoppedBy ?? "none",
      seats: seatStatus,
    });

    return { daysImported, seatStatus, nextCursor: outcome.nextCursor, stoppedBy: outcome.stoppedBy };
  } catch (error) {
    await audit("FAILED", { error: error instanceof ProviderError ? error.code : "INTERNAL" });
    throw error;
  }
}
