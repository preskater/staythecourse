import { listOpenRouterTotals, openRouterAdapter } from "@/modules/integrations/openrouter";
import { importAiProvider, type AiImportDependencies, type AiImportInput, type AiImportResult } from "./ai-import";

/**
 * Imports one window of OpenRouter usage and spend (M11-04), server-side only, through
 * `importAiProvider`. Lines carry the API key they belong to; usage of no listed key is
 * stored without key (unknown, so unallocated) and reported as a warning. Per-key data
 * is sensitive: it never leaves the server and the audit entry holds counts only.
 */
export function importOpenRouterUsageAndCosts(
  input: AiImportInput,
  dependencies: Partial<Omit<AiImportDependencies, "provider">> = {},
): Promise<AiImportResult> {
  return importAiProvider(input, {
    provider: "OPENROUTER",
    adapter: openRouterAdapter,
    organizationTotals: listOpenRouterTotals,
    now: () => new Date(),
    ...dependencies,
  });
}
