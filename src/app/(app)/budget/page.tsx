import Link from "next/link";
import { ChevronDown, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth/guard";
import { ModuleDisabled } from "@/components/module-disabled";
import { hasModule } from "@/modules/catalog/catalog";
import { currentMonthKey, formatMonthLabel, isValidMonthKey, parseMonthKey } from "@/lib/dates";
import { readSearchParam, type SearchParamsInput } from "@/lib/search-params";
import { TRANSACTION_TYPES, type TransactionType } from "@/modules/budget/domain";
import { TRANSACTION_SORTS } from "@/modules/budget/repository";
import { AccountsSection } from "./accounts-section";
import { AnalysisSection } from "./analysis-section";
import type { BudgetFilterValues } from "./budget-filters";
import { BudgetTabs, resolveBudgetTab, type BudgetTab } from "./budget-tabs";
import { BudgetsSection } from "./budgets-section";
import { ForecastSection } from "./forecast-section";
import { GoalsSection } from "./goals-section";
import { OperationsSection } from "./operations-section";
import { ReportSection } from "./report-section";
import { SalarySection } from "./salary-section";
import { SavingsThresholdCard } from "./savings-threshold-card";
import { ExpenseSimulationModal } from "./expense-simulation-modal";
import { listAccounts, listCategories } from "@/modules/budget/repository";
import { DEFAULT_CURRENCY } from "@/lib/money";

export const dynamic = "force-dynamic";

export default async function BudgetPage({
  searchParams,
}: {
  searchParams: Promise<SearchParamsInput>;
}) {
  const user = await requireUser();
  // A direct link explains the state instead of a 404, and reads nothing of the module.
  if (!hasModule(user.workspace, "budget")) {
    return <ModuleDisabled moduleKey="budget" workspace={user.workspace} />;
  }
  const params = await searchParams;

  const requestedMonth = readSearchParam(params, "month");
  const monthKey = isValidMonthKey(requestedMonth) ? requestedMonth : currentMonthKey();
  const { year, month } = parseMonthKey(monthKey);
  const monthLabel = formatMonthLabel(year, month);
  const [accounts, categories] = await Promise.all([
    listAccounts(user.workspace.id),
    listCategories(user.workspace.id),
  ]);
  const expenseCategories = categories.filter((category) => category.kind === "EXPENSE");

  const rawType = readSearchParam(params, "type");
  const rawReconciled = readSearchParam(params, "reconciled");
  const filters: BudgetFilterValues = {
    accountId: readSearchParam(params, "account"),
    categoryId: readSearchParam(params, "category"),
    type: TRANSACTION_TYPES.find((value) => value === rawType),
    search: readSearchParam(params, "q"),
    // "0" / "1" are the wire values of the filter; anything else means "all".
    reconciled: rawReconciled === "0" ? false : rawReconciled === "1" ? true : undefined,
  };
  // Which side of the ledger the breakdown shows. Expenses by default: that is the
  // question people actually ask.
  const breakdownKind: TransactionType =
    readSearchParam(params, "breakdown") === "INCOME" ? "INCOME" : "EXPENSE";

  // The rows being corrected are read by the sections from the owner's own data, never
  // taken from the query string: `?edit=`, `?editBudget=` and `?editGoal=` are identifiers
  // to look up, not authorisations.
  const editId = readSearchParam(params, "edit");
  // A duplication is a pre-filled creation form: the row is read for its values, and
  // nothing is written until the owner submits.
  const copyId = readSearchParam(params, "copy");
  const editBudgetId = readSearchParam(params, "editBudget");
  const editGoalId = readSearchParam(params, "editGoal");
  const editRecurringId = readSearchParam(params, "editRecurring");
  // The rolling-average suggestion flow: open the budget form pre-filled from a link.
  const newBudgetCategory = readSearchParam(params, "newBudgetCategory");
  const newBudgetCurrency = readSearchParam(params, "newBudgetCurrency");

  // The operations list's own controls: a whitelisted sort, its direction and the page.
  const rawSort = readSearchParam(params, "sort");
  const sort = TRANSACTION_SORTS.find((value) => value === rawSort);
  const dir = readSearchParam(params, "dir") === "asc" ? "asc" : "desc";
  const rawPage = Number(readSearchParam(params, "page") ?? "1");
  const page = Number.isInteger(rawPage) && rawPage >= 1 ? rawPage : 1;
  const scopeAll = readSearchParam(params, "all") === "1";

  const tab = resolveBudgetTab(readSearchParam(params, "tab"), { editBudgetId, editGoalId, editRecurringId });

  // Month and filters travel from tab to tab (and to the CSV export), so switching a
  // section never silently changes what is displayed. Edition identifiers are left out:
  // opening a tab leaves the correction flow instead of replaying it. Sort and page are
  // the operations list's own state and are rebuilt there, not carried across tabs.
  const baseParams = new URLSearchParams({ month: monthKey });
  if (filters.accountId) baseParams.set("account", filters.accountId);
  if (filters.categoryId) baseParams.set("category", filters.categoryId);
  if (filters.type) baseParams.set("type", filters.type);
  if (filters.search) baseParams.set("q", filters.search);
  if (filters.reconciled !== undefined) {
    baseParams.set("reconciled", filters.reconciled ? "1" : "0");
  }
  if (scopeAll) baseParams.set("all", "1");

  const descriptions: Record<BudgetTab, string> = {
    operations: scopeAll
      ? "Recherche dans tous les mois, tous les résultats filtrés. Les montants sont signés : une sortie est négative."
      : `Opérations de ${monthLabel}. Les montants sont signés : une sortie est négative.`,
    analysis: `Analyse de ${monthLabel} : totaux, tendance sur 12 mois, comparaison au mois précédent et à l'an dernier, et répartition par catégorie. Les transferts entre comptes comptent selon leur signe.`,
    budgets: `Budgets de ${monthLabel}, par catégorie et par devise. Les devises ne sont jamais converties.`,
    report: `Suivi du budget de ${monthLabel} : prévu, réalisé et reste par catégorie et par devise, sans conversion.`,
    forecast: `Prévisions de ${monthLabel} : échéances attendues des séries récurrentes, salaire simulé du mois et échéancier des six mois suivants — salaire compris, avec solde simulé de fin de mois — à confirmer. Rien ne compte dans un total réel avant d'être enregistré.`,
    goals: "Objectifs d'épargne ou de remboursement : progression, contributions datées, reste à atteindre et seuil de coussin de sécurité. Un solde inconnu ne vaut jamais zéro, et aucune devise n'est convertie.",
    salary: `Salaire simulé de ${monthLabel} : un taux horaire propre au mois (effectif à partir du mois saisi, jusqu'au prochain taux), un calendrier de jours prévus puis travaillés, et la recette du mois en un clic.`,
    accounts: "Comptes et catégories : soldes enregistrés, solde projeté de fin de mois (échéances en attente comprises), renommage, archivage, fusion et suppression. Tout ce qui est utilisé est dit avant d'être modifié.",
  };

  // The exports always speak about the same selection as the screen: month by default,
  // the whole year or every month when the scope asks for it.
  const monthExportHref = `/api/export/transactions?${baseParams.toString()}`;
  const wideParams = new URLSearchParams();
  if (scopeAll) {
    wideParams.set("all", "1");
  } else {
    wideParams.set("year", String(year));
  }
  if (filters.accountId) wideParams.set("account", filters.accountId);
  if (filters.categoryId) wideParams.set("category", filters.categoryId);
  if (filters.type) wideParams.set("type", filters.type);
  if (filters.search) wideParams.set("q", filters.search);
  if (filters.reconciled !== undefined) {
    wideParams.set("reconciled", filters.reconciled ? "1" : "0");
  }

  return (
    <>
      <PageHeader
        title="Budget"
        description={descriptions[tab]}
        actions={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Link
              href="/budget/loans"
              className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
            >
              Prêts
            </Link>
            <ExpenseSimulationModal
              accounts={accounts}
              categories={expenseCategories}
              defaultCurrency={accounts[0]?.currency ?? DEFAULT_CURRENCY}
            />
            <details className="group relative">
              <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800 [&::-webkit-details-marker]:hidden">
                Importer / Exporter
                <ChevronDown className="h-4 w-4 text-zinc-500 transition-transform group-open:rotate-180 dark:text-zinc-400" />
              </summary>
              <div className="absolute right-0 z-20 mt-1 w-64 rounded-md border border-zinc-200 bg-white p-1 shadow-lg dark:border-zinc-800 dark:bg-zinc-900">
                <Link
                  href="/budget/import"
                  className="block rounded px-3 py-2 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
                >
                  Importer un CSV
                </Link>
                <Link
                  href={monthExportHref}
                  className="block rounded px-3 py-2 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
                >
                  Exporter le mois en CSV
                </Link>
                <Link
                  href={`/api/export/transactions?${wideParams.toString()}`}
                  className="block rounded px-3 py-2 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
                >
                  {scopeAll ? "Exporter tout" : `Exporter ${year}`}
                </Link>
              </div>
            </details>
          </div>
        }
      />

      <BudgetTabs current={tab} baseParams={baseParams} />

      {tab === "operations" ? (
        <OperationsSection
          workspaceId={user.workspace.id}
          monthKey={monthKey}
          filters={filters}
          editId={editId}
          copyId={copyId}
          sort={sort}
          dir={dir}
          page={page}
          scopeAll={scopeAll}
        />
      ) : null}

      {tab === "analysis" ? (
        <AnalysisSection
          workspaceId={user.workspace.id}
          monthKey={monthKey}
          filters={filters}
          breakdownKind={breakdownKind}
        />
      ) : null}

      {tab === "budgets" ? (
        <BudgetsSection
          workspaceId={user.workspace.id}
          monthKey={monthKey}
          editBudgetId={editBudgetId}
          newBudgetCategory={newBudgetCategory}
          newBudgetCurrency={newBudgetCurrency}
        />
      ) : null}

      {tab === "report" ? <ReportSection workspaceId={user.workspace.id} monthKey={monthKey} /> : null}

      {tab === "forecast" ? (
        <ForecastSection
          workspaceId={user.workspace.id}
          monthKey={monthKey}
          editRecurringId={editRecurringId}
        />
      ) : null}

      {tab === "goals" ? (
        <>
          <SavingsThresholdCard workspaceId={user.workspace.id} />
          <GoalsSection workspaceId={user.workspace.id} editGoalId={editGoalId} />
        </>
      ) : null}

      {tab === "salary" ? <SalarySection workspaceId={user.workspace.id} monthKey={monthKey} /> : null}

      {tab === "accounts" ? (
        <AccountsSection workspaceId={user.workspace.id} monthKey={monthKey} />
      ) : null}
    </>
  );
}
