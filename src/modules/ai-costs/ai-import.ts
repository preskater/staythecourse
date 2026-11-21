import type Decimal from "decimal.js";
import { recordAuditEventSafely } from "@/modules/audit/repository";
import { ProviderError } from "@/modules/integrations/adapter";
import type {
  AiPageOutcome,
  AiPageRequest,
  AiPageStop,
  AiProvider,
  AiProviderAdapter,
  AiSyncWarning,
  AiUsageRecord,
} from "@/modules/integrations/ai-adapter";
import { reconcileTotals, type ReconciliationResult } from "./reconciliation";
import { sumAiCostLines, upsertAiCostLines, upsertAiUsageLines } from "./repository";

/**
 * Imports one window of an AI provider's costs, and its usage when the adapter reads
 * usage (M11-02, M11-03), server-side only.
 *
 * 1. reads the grouped cost lines, then the usage lines, each bounded by `maxPages`
 *    and resumable through its own cursor;
 * 2. upserts them, so a re-run creates nothing new;
 * 3. when the costs were fully read, compares the **stored** lines of the window with
 *    the organization total the provider reports for it (see `reconciliation.ts`).
 *    Using the stored lines makes a window imported over several resumed runs
 *    reconcilable;
 * 4. writes an audit entry, the record of the sync run: counts and codes only, never an
 *    amount or the key. Adapter warnings (categories not imported authoritatively) are
 *    attached to it and returned, never dropped.
 *
 * The key arrives in `request.token`; storing it encrypted is M11-05.
 */

export type AiImportResult = {
  linesImported: number;
  /** Where the next cost read resumes; `null` once the window is fully read. */
  nextCursor: string | null;
  stoppedBy: AiPageStop | null;
  /** `null` when the provider's usage is not tracked: not the same as "no usage". */
  usageLinesImported: number | null;
  usageNextCursor: string | null;
  usageStoppedBy: AiPageStop | null;
  warnings: AiSyncWarning[];
  reconciliation: ReconciliationResult;
};

export type AiProviderTotals = (request: Omit<AiPageRequest, "cursor">) => Promise<{
  /** Sum per uppercase currency, exact. */
  totals: Map<string, Decimal>;
  /** False when the bound or a refusal cut the read: the totals are then not comparable. */
  complete: boolean;
}>;

export type AiImportDependencies = {
  provider: AiProvider;
  adapter: Pick<AiProviderAdapter, "listCosts" | "listUsage">;
  organizationTotals: AiProviderTotals;
  now: () => Date;
};

export type AiImportInput = {
  workspaceId: string;
  /** Signed-in owner, or `null` for a scheduled job. */
  actorId: string | null;
  connectionKey: string;
  /** `request.cursor` resumes the cost read. */
  request: AiPageRequest;
  /** Resumes the usage read; `null` or absent starts it from the first page. */
  usageCursor?: string | null;
};

/** One entry per code; a window-level warning (`count: null`) stays window-level. */
function mergeWarnings(...lists: (AiSyncWarning[] | undefined)[]): AiSyncWarning[] {
  const merged = new Map<string, number | null>();
  for (const { code, count } of lists.flatMap((list) => list ?? [])) {
    const previous = merged.has(code) ? merged.get(code)! : 0;
    merged.set(code, previous === null || count === null ? null : previous + count);
  }
  return [...merged].map(([code, count]) => ({ code, count }));
}

/**
 * Usage is read after the costs, often within the same throttling window: a refusal on
 * its first page postpones it to the next run (same cursor) instead of failing a run
 * whose costs are already stored. With `usageStoppedBy` set, a `null` cursor means
 * "start from the first page", not "complete".
 */
async function readUsage(
  listUsage: NonNullable<AiProviderAdapter["listUsage"]>,
  input: AiImportInput,
  now: () => Date,
): Promise<AiPageOutcome<AiUsageRecord>> {
  const cursor = input.usageCursor ?? null;
  try {
    return await listUsage({ ...input.request, cursor });
  } catch (error) {
    if (error instanceof ProviderError && (error.code === "RATE_LIMITED" || error.code === "NETWORK")) {
      return { records: [], nextCursor: cursor, stoppedBy: error.code, pagesRead: 0, fetchedAt: now() };
    }
    throw error;
  }
}

export async function importAiProvider(
  input: AiImportInput,
  dependencies: AiImportDependencies,
): Promise<AiImportResult> {
  const { provider, adapter, organizationTotals, now } = dependencies;
  const audit = (outcome: "SUCCESS" | "FAILED", metadata: Record<string, unknown>) =>
    recordAuditEventSafely({
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      action: "integration.sync",
      entityType: "INTEGRATION",
      entityId: input.connectionKey,
      outcome,
      metadata: { provider, kind: "ai_costs", ...metadata },
    });

  try {
    const costs = await adapter.listCosts(input.request);
    const linesImported = await upsertAiCostLines(input.workspaceId, {
      connectionKey: input.connectionKey,
      provider,
      records: costs.records,
      fetchedAt: now(),
    });

    const usage = adapter.listUsage ? await readUsage(adapter.listUsage, input, now) : null;
    const usageLinesImported = usage
      ? await upsertAiUsageLines(input.workspaceId, {
          connectionKey: input.connectionKey,
          provider,
          records: usage.records,
          fetchedAt: now(),
        })
      : null;

    let reconciliation: ReconciliationResult = { status: "INCOMPLETE", currencies: [] };

    if (costs.stoppedBy === null) {
      const reported = await organizationTotals(input.request);
      const imported = await sumAiCostLines(input.workspaceId, {
        connectionKey: input.connectionKey,
        start: input.request.start,
        end: input.request.end,
      });
      reconciliation = reconcileTotals({ imported, provider: reported.totals, complete: reported.complete });
    }

    const warnings = mergeWarnings(costs.warnings, usage?.warnings);

    await audit("SUCCESS", {
      lines: linesImported,
      pages: costs.pagesRead,
      stoppedBy: costs.stoppedBy ?? "none",
      reconciliation: reconciliation.status,
      ...(usage && {
        usageLines: usageLinesImported,
        usageStoppedBy: usage.stoppedBy ?? "none",
      }),
      warnings: warnings.length,
      // Flat keys, as the audit metadata only keeps codes and numbers.
      ...Object.fromEntries(warnings.map(({ code, count }) => [`warn_${code}`, count ?? true])),
    });

    return {
      linesImported,
      nextCursor: costs.nextCursor,
      stoppedBy: costs.stoppedBy,
      usageLinesImported,
      usageNextCursor: usage?.nextCursor ?? null,
      usageStoppedBy: usage?.stoppedBy ?? null,
      warnings,
      reconciliation,
    };
  } catch (error) {
    await audit("FAILED", {
      error: error instanceof ProviderError ? error.code : "INTERNAL",
    });
    throw error;
  }
}
