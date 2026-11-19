import Link from "next/link";

/**
 * The budget page's sub-sections.
 *
 * The page had grown into one long column — entry, filters, indicators, charts, the
 * month's list, the budgets, their follow-up and the salary simulator. Each tab is a
 * link rather than a client-side toggle: the choice lives in the URL (`?tab=`), so a
 * view is shareable and survives a refresh, and only the active section's queries run
 * on the server.
 */
export const BUDGET_TABS = [
  { id: "operations", label: "Opérations" },
  { id: "analysis", label: "Analyse" },
  { id: "budgets", label: "Budgets" },
  { id: "report", label: "Suivi" },
  { id: "forecast", label: "Prévisions" },
  { id: "goals", label: "Objectifs" },
  { id: "loans", label: "Prêts" },
  { id: "salary", label: "Salaire" },
  { id: "accounts", label: "Comptes" },
] as const;

export type BudgetTab = (typeof BUDGET_TABS)[number]["id"];

/**
 * Which tab to display.
 *
 * An explicit, valid `?tab=` wins. Otherwise an edition link decides: `?editBudget=`
 * belongs to the budgets tab, `?editGoal=` to the goals tab, `?editLoan=` to the loans
 * tab, and everything else — including `?edit=` — lands on operations, so links written
 * before the tabs existed keep working.
 */
export function resolveBudgetTab(
  requested: string | undefined,
  options: {
    editBudgetId?: string;
    editGoalId?: string;
    editRecurringId?: string;
    editLoanId?: string;
  } = {},
): BudgetTab {
  const explicit = BUDGET_TABS.find((tab) => tab.id === requested);
  if (explicit) {
    return explicit.id;
  }

  if (options.editBudgetId) {
    return "budgets";
  }

  if (options.editRecurringId) {
    return "forecast";
  }

  if (options.editLoanId) {
    return "loans";
  }

  return options.editGoalId ? "goals" : "operations";
}

/**
 * The tab bar.
 *
 * `baseParams` carries the month and the filters from tab to tab, so switching a section
 * never silently changes what is displayed. Edition identifiers are deliberately absent:
 * opening a tab leaves the correction flow instead of replaying it.
 */
export function BudgetTabs({
  current,
  baseParams,
}: {
  current: BudgetTab;
  baseParams: URLSearchParams;
}) {
  return (
    <nav aria-label="Sections du budget" className="flex flex-wrap gap-1">
      {BUDGET_TABS.map((tab) => {
        const params = new URLSearchParams(baseParams);
        params.set("tab", tab.id);

        return (
          <Link
            key={tab.id}
            href={`/budget?${params.toString()}`}
            aria-current={tab.id === current ? "page" : undefined}
            className={
              tab.id === current
                ? "rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
                : "rounded-md px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
            }
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
