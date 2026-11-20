import { listOpenAiOrganizationTotals, openAiAdapter } from "@/modules/integrations/openai";
import { importAiProvider, type AiImportDependencies, type AiImportInput, type AiImportResult } from "./ai-import";

/**
 * Imports one window of OpenAI organization costs (M11-02), server-side only. The
 * steps, reconciliation and audit are those of `importAiProvider`; OpenAI usage is not
 * read, so `usageLinesImported` is `null` ("not tracked").
 */

export type OpenAiImportResult = AiImportResult;

export function importOpenAiCosts(
  input: Omit<AiImportInput, "usageCursor">,
  dependencies: Partial<Omit<AiImportDependencies, "provider">> = {},
): Promise<OpenAiImportResult> {
  return importAiProvider(input, {
    provider: "OPENAI",
    adapter: openAiAdapter,
    organizationTotals: listOpenAiOrganizationTotals,
    now: () => new Date(),
    ...dependencies,
  });
}
