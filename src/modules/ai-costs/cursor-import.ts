import { cursorAdapter, listCursorTotals } from "@/modules/integrations/cursor";
import { importAiProvider, type AiImportDependencies, type AiImportInput, type AiImportResult } from "./ai-import";

/**
 * Imports one window of Cursor team usage and spend (M11-07), server-side only, through
 * `importAiProvider`. Lines carry the member's opaque id, never a name or an email.
 * Cursor offers no independent windowed total: the reconciliation stays `INCOMPLETE`.
 */
export function importCursorUsageAndCosts(
  input: AiImportInput,
  dependencies: Partial<Omit<AiImportDependencies, "provider">> = {},
): Promise<AiImportResult> {
  return importAiProvider(input, {
    provider: "CURSOR",
    adapter: cursorAdapter,
    organizationTotals: listCursorTotals,
    now: () => new Date(),
    ...dependencies,
  });
}
