import { recordAuditEventSafely } from "@/modules/audit/repository";
import { ProviderError } from "@/modules/integrations/adapter";
import type { AiPageRequest, AiPageStop, AiProviderAdapter } from "@/modules/integrations/ai-adapter";
import {
  listOpenAiOrganizationTotals,
  openAiAdapter,
  type OpenAiOrganizationTotals,
} from "@/modules/integrations/openai";
import { reconcileTotals, type ReconciliationResult } from "./reconciliation";
import { sumAiCostLines, upsertAiCostLines } from "./repository";

/**
 * Imports one window of OpenAI organization costs (M11-02), server-side only.
 *
 * 1. reads the grouped cost lines, bounded by `maxPages`;
 * 2. upserts them, so a re-run creates nothing new;
 * 3. when the window was fully read, compares the **stored** lines of the window with
 *    the organization total OpenAI reports for it (see `reconciliation.ts`). Using the
 *    stored lines makes a window imported over several resumed runs reconcilable;
 * 4. writes an audit entry: counts and codes only, never an amount or the key.
 *
 * The admin key arrives in `request.token`; storing it encrypted is M11-05.
 */

export type OpenAiImportResult = {
  linesImported: number;
  /** Where the next run resumes; `null` once the window is fully read. */
  nextCursor: string | null;
  stoppedBy: AiPageStop | null;
  reconciliation: ReconciliationResult;
};

type Dependencies = {
  adapter: Required<Pick<AiProviderAdapter, "listCosts">>;
  organizationTotals: (request: Omit<AiPageRequest, "cursor">) => Promise<OpenAiOrganizationTotals>;
  now: () => Date;
};

const DEFAULT_DEPENDENCIES: Dependencies = {
  adapter: openAiAdapter,
  organizationTotals: listOpenAiOrganizationTotals,
  now: () => new Date(),
};

export async function importOpenAiCosts(
  input: {
    workspaceId: string;
    /** Signed-in owner, or `null` for a scheduled job. */
    actorId: string | null;
    connectionKey: string;
    request: AiPageRequest;
  },
  dependencies: Partial<Dependencies> = {},
): Promise<OpenAiImportResult> {
  const { adapter, organizationTotals, now } = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  const audit = (outcome: "SUCCESS" | "FAILED", metadata: Record<string, unknown>) =>
    recordAuditEventSafely({
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      action: "integration.sync",
      entityType: "INTEGRATION",
      entityId: input.connectionKey,
      outcome,
      metadata: { provider: "OPENAI", kind: "ai_costs", ...metadata },
    });

  try {
    const outcome = await adapter.listCosts(input.request);
    const linesImported = await upsertAiCostLines(input.workspaceId, {
      connectionKey: input.connectionKey,
      provider: "OPENAI",
      records: outcome.records,
      fetchedAt: now(),
    });

    let reconciliation: ReconciliationResult = { status: "INCOMPLETE", currencies: [] };

    if (outcome.stoppedBy === null) {
      const provider = await organizationTotals(input.request);
      const imported = await sumAiCostLines(input.workspaceId, {
        connectionKey: input.connectionKey,
        start: input.request.start,
        end: input.request.end,
      });
      reconciliation = reconcileTotals({ imported, provider: provider.totals, complete: provider.complete });
    }

    await audit("SUCCESS", {
      lines: linesImported,
      pages: outcome.pagesRead,
      stoppedBy: outcome.stoppedBy ?? "none",
      reconciliation: reconciliation.status,
    });

    return {
      linesImported,
      nextCursor: outcome.nextCursor,
      stoppedBy: outcome.stoppedBy,
      reconciliation,
    };
  } catch (error) {
    await audit("FAILED", {
      error: error instanceof ProviderError ? error.code : "INTERNAL",
    });
    throw error;
  }
}
