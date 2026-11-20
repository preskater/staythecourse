import { anthropicAdapter, listAnthropicOrganizationTotals } from "@/modules/integrations/anthropic";
import { importAiProvider, type AiImportDependencies, type AiImportInput, type AiImportResult } from "./ai-import";

/**
 * Imports one window of Anthropic usage and costs (M11-03), server-side only, through
 * `importAiProvider`. The window is at most 31 days and starts and ends on a UTC
 * midnight (see `anthropic.ts`). Categories Anthropic does not report authoritatively
 * come back as `warnings` and are attached to the run's audit entry.
 */
export function importAnthropicUsageAndCosts(
  input: AiImportInput,
  dependencies: Partial<Omit<AiImportDependencies, "provider">> = {},
): Promise<AiImportResult> {
  return importAiProvider(input, {
    provider: "ANTHROPIC",
    adapter: anthropicAdapter,
    organizationTotals: listAnthropicOrganizationTotals,
    now: () => new Date(),
    ...dependencies,
  });
}
