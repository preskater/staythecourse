import Link from "next/link";

/**
 * The AI costs page's sections. Same bar as the budget's: the tab lives in the URL
 * (`?tab=`), so a view is shareable and only the active section's queries run.
 */
export const AI_COSTS_TABS = [
  { id: "overview", label: "Vue d'ensemble" },
  { id: "explorer", label: "Explorer" },
] as const;

export type AiCostsTab = (typeof AI_COSTS_TABS)[number]["id"];

export function resolveAiCostsTab(requested: string | string[] | undefined): AiCostsTab {
  return AI_COSTS_TABS.find((tab) => tab.id === requested)?.id ?? "overview";
}

export function AiCostsTabs({ current }: { current: AiCostsTab }) {
  return (
    <nav aria-label="Sections des coûts IA" className="flex flex-wrap gap-1">
      {AI_COSTS_TABS.map((tab) => (
        <Link
          key={tab.id}
          href={`/ai-costs?tab=${tab.id}`}
          aria-current={tab.id === current ? "page" : undefined}
          className={
            tab.id === current
              ? "rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
              : "rounded-md px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
          }
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
