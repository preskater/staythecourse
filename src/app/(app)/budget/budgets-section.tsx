import Link from "next/link";
import {
  Card,
  EmptyState,
  Notice,
  TableShell,
  tdClass,
  thClass,
} from "@/components/ui";
import { formatMonthLabel, monthKeysEndingAt, monthRange, parseMonthKey, shiftMonthKey } from "@/lib/dates";
import { formatMoney, isSupportedCurrency, toDecimalString, type Currency } from "@/lib/money";
import { toBudgetFormInitialValues, type CategoryKind } from "@/modules/budget/domain";
import {
  findBudget,
  listBudgets,
  listCategories,
  listTransactionsForSeries,
} from "@/modules/budget/repository";
import { AVERAGE_WINDOW_MONTHS, computeCategoryAverages } from "@/modules/budget/averages";
import { sumPerCurrency } from "@/modules/budget/table-totals";
import { BudgetForm } from "./budget-form";
import { CopyBudgetsButton } from "./copy-budgets-button";
import { DeleteBudgetButton } from "./delete-budget-button";

const CATEGORY_KIND_LABELS: Record<CategoryKind, string> = {
  INCOME: "Recette",
  EXPENSE: "Dépense",
};

/**
 * "Budgets" tab: the planned amounts of one month, per category and currency.
 *
 * The section reads its own data: no transaction, no chart window. The month picker
 * belongs to this tab because budgets are consulted month by month, like the operations.
 */
export async function BudgetsSection({
  workspaceId,
  monthKey,
  editBudgetId,
  newBudgetCategory,
  newBudgetCurrency,
}: {
  workspaceId: string;
  /** `YYYY-MM`, the month shared by every tab. */
  monthKey: string;
  /** `?editBudget=`, an identifier to look up: a foreign one finds nothing. */
  editBudgetId?: string;
  /** `?newBudgetCategory=`, opening the form from a rolling-average suggestion. */
  newBudgetCategory?: string;
  /** `?newBudgetCurrency=`, the suggestion's currency. */
  newBudgetCurrency?: string;
}) {
  const { year, month } = parseMonthKey(monthKey);

  // The rolling window: the three months **before** the displayed one — a running month
  // is not an average yet. Bounded like every series read; if the bound is reached the
  // averages are hidden rather than computed on a partial history.
  const averageMonthKeys = monthKeysEndingAt(monthKey, AVERAGE_WINDOW_MONTHS + 1).slice(
    0,
    AVERAGE_WINDOW_MONTHS,
  );
  const firstAverageMonth = parseMonthKey(averageMonthKeys[0]);
  const averageStart = monthRange(firstAverageMonth.year, firstAverageMonth.month);
  const averageEnd = monthRange(year, month).start;

  const [categories, budgets, editBudgetTarget, averageRead] = await Promise.all([
    listCategories(workspaceId),
    // The budgets of the displayed month: the section never mixes months or currencies.
    listBudgets(workspaceId, { year, month }),
    editBudgetId ? findBudget(workspaceId, editBudgetId) : Promise.resolve(null),
    listTransactionsForSeries(workspaceId, { from: averageStart.start, to: averageEnd }),
  ]);

  const averages = averageRead.truncated
    ? []
    : computeCategoryAverages(averageRead.transactions, {
        monthCount: AVERAGE_WINDOW_MONTHS,
      });
  const averageByCategoryCurrency = new Map(
    averages.map((average) => [`${average.categoryId}|${average.currency}`, average]),
  );

  // Footer of the average column: a category with no recent average contributes nothing
  // and marks its currency incomplete, so the row shows "—" (see `sumPerCurrency`).
  const budgetAmountTotals = sumPerCurrency(budgets, (budget) => ({
    currency: budget.currency,
    amount: budget.amount,
  }));
  const budgetAverageTotals = sumPerCurrency(budgets, (budget) => ({
    currency: budget.currency,
    amount:
      averageByCategoryCurrency.get(`${budget.categoryId}|${budget.currency}`)?.monthlyAverage ??
      null,
  }));

  // A suggestion is a category with a recent average and no budget yet for that month and
  // currency: the list offers to open the form with the average already in it.
  const budgetKeys = new Set(budgets.map((budget) => `${budget.categoryId}|${budget.currency}`));
  const suggestions = averages.filter(
    (average) => !budgetKeys.has(`${average.categoryId}|${average.currency}`),
  );

  const requestedCurrency =
    newBudgetCurrency !== undefined && isSupportedCurrency(newBudgetCurrency)
      ? (newBudgetCurrency as Currency)
      : undefined;
  const requestedSuggestion = newBudgetCategory
    ? averages.find(
        (average) =>
          average.categoryId === newBudgetCategory &&
          (requestedCurrency === undefined || average.currency === requestedCurrency),
      )
    : undefined;

  // A stale or foreign identifier fills nothing and is reported, so the form never looks
  // like it silently lost the row.
  const budgetEditing = editBudgetTarget;
  const budgetEditTargetIsHidden = Boolean(editBudgetId) && editBudgetTarget === null;

  // Where "Annuler" returns to, month and tab preserved.
  const listHref = `/budget?month=${monthKey}&tab=budgets`;
  const previousKey = shiftMonthKey(monthKey, -1);
  const previous = parseMonthKey(previousKey);
  const previousLabel = formatMonthLabel(previous.year, previous.month);

  return (
    <Card
      title={`Budgets mensuels — ${formatMonthLabel(year, month)}`}
      description="Montants prévus par catégorie et par devise pour le mois affiché. Un budget est toujours positif ; les devises restent séparées et ne sont jamais converties."
      actions={
        <span className="flex flex-wrap items-center gap-2">
          <CopyBudgetsButton monthKey={monthKey} previousLabel={previousLabel} />
          <a
            href={`/api/export/budgets?month=${monthKey}`}
            download
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            Exporter en CSV
          </a>
        </span>
      }
    >
      <form method="get" action="/budget" className="mb-4 flex flex-wrap items-end gap-2">
        <input type="hidden" name="tab" value="budgets" />

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Mois affiché</span>
          <input
            type="month"
            name="month"
            defaultValue={monthKey}
            className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-900"
          />
        </label>

        <button
          type="submit"
          className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
        >
          Afficher
        </button>
      </form>

      {budgetEditTargetIsHidden ? (
        <Notice tone="warning">
          Le budget demandé n&apos;existe plus, ou ne fait pas partie de vos données : le
          formulaire reste en mode création.
        </Notice>
      ) : null}

      {budgetEditing ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm font-medium">
            Modifier le budget « {budgetEditing.categoryName} —{" "}
            {formatMonthLabel(budgetEditing.year, budgetEditing.month)} (
            {budgetEditing.currency}) »
          </p>
          <BudgetForm
            key={budgetEditing.id}
            categories={categories}
            defaultMonth={monthKey}
            editing={toBudgetFormInitialValues(budgetEditing)}
            cancelHref={listHref}
          />
        </div>
      ) : (
        <details open={Boolean(requestedSuggestion)}>
          <summary className="cursor-pointer text-sm font-medium">Nouveau budget</summary>
          <div className="pt-3">
            <BudgetForm
              categories={categories}
              defaultMonth={monthKey}
              defaultCategoryId={requestedSuggestion?.categoryId}
              defaultCurrency={requestedSuggestion?.currency}
              defaultAmount={
                requestedSuggestion ? toDecimalString(requestedSuggestion.monthlyAverage) : undefined
              }
              averageHint={
                requestedSuggestion
                  ? `Moyenne des ${AVERAGE_WINDOW_MONTHS} derniers mois : ${formatMoney({
                      amount: requestedSuggestion.monthlyAverage,
                      currency: requestedSuggestion.currency,
                    })} (${requestedSuggestion.activeMonths} mois actif${requestedSuggestion.activeMonths > 1 ? "s" : ""} sur ${AVERAGE_WINDOW_MONTHS}). Ajustez librement.`
                  : undefined
              }
            />
          </div>
        </details>
      )}

      {averageRead.truncated ? (
        <Notice tone="warning">
          Trop d&apos;opérations sur les {AVERAGE_WINDOW_MONTHS} derniers mois pour
          calculer des moyennes fiables : la colonne reste vide plutôt que de montrer un
          chiffre partiel.
        </Notice>
      ) : null}

      <div className="mt-4">
        {budgets.length === 0 ? (
          <EmptyState
            title={`Aucun budget pour ${formatMonthLabel(year, month)}`}
            description="Ce n'est pas un montant prévu à zéro : aucune ligne n'existe pour ce mois. Un budget se définit ci-dessus, par catégorie et par devise."
          />
        ) : (
          <TableShell caption="Budgets du mois">
            <thead>
              <tr>
                <th scope="col" className={thClass}>
                  Catégorie
                </th>
                <th scope="col" className={thClass}>
                  Nature
                </th>
                <th scope="col" className={thClass}>
                  Devise
                </th>
                <th scope="col" className={`${thClass} text-right`}>
                  Montant prévu
                </th>
                <th scope="col" className={`${thClass} text-right`}>
                  Moyenne {AVERAGE_WINDOW_MONTHS} mois
                </th>
                <th scope="col" className={thClass}>
                  Action
                </th>
              </tr>
            </thead>
            <tbody>
              {budgets.map((budget) => (
                <tr
                  key={budget.id}
                  className={
                    budgetEditing?.id === budget.id
                      ? "bg-amber-50 dark:bg-amber-950/30"
                      : undefined
                  }
                >
                  <td className={tdClass}>{budget.categoryName}</td>
                  <td className={tdClass}>{CATEGORY_KIND_LABELS[budget.categoryKind]}</td>
                  <td className={tdClass}>{budget.currency}</td>
                  <td className={`${tdClass} whitespace-nowrap text-right tabular-nums`}>
                    {formatMoney({
                      amount: budget.amount,
                      currency: budget.currency,
                    })}
                  </td>
                  <td className={`${tdClass} whitespace-nowrap text-right tabular-nums`}>
                    {(() => {
                      const average = averageByCategoryCurrency.get(
                        `${budget.categoryId}|${budget.currency}`,
                      );

                      return average
                        ? formatMoney({
                            amount: average.monthlyAverage,
                            currency: average.currency,
                          })
                        : "—";
                    })()}
                  </td>
                  <td className={tdClass}>
                    <div className="flex flex-col items-start gap-1">
                      <Link
                        href={`${listHref}&editBudget=${budget.id}`}
                        className="rounded-md border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
                      >
                        Modifier
                      </Link>
                      <DeleteBudgetButton
                        budgetId={budget.id}
                        label={`${budget.categoryName} — ${formatMonthLabel(
                          budget.year,
                          budget.month,
                        )} (${budget.currency})`}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              {[...budgetAmountTotals.values()].map(({ currency, amount }) => {
                const average = budgetAverageTotals.get(currency);

                return (
                  <tr key={currency}>
                    <th
                      scope="row"
                      colSpan={3}
                      className={`${tdClass} text-right font-semibold`}
                    >
                      Total ({currency})
                    </th>
                    <td className={`${tdClass} whitespace-nowrap text-right font-semibold tabular-nums`}>
                      {formatMoney({ amount, currency })}
                    </td>
                    <td className={`${tdClass} whitespace-nowrap text-right font-semibold tabular-nums`}>
                      {average?.complete ? (
                        formatMoney({ amount: average.amount, currency })
                      ) : (
                        <span title="Au moins une catégorie n'a pas de moyenne : le total serait incomplet.">
                          —
                        </span>
                      )}
                    </td>
                    <td className={tdClass} />
                  </tr>
                );
              })}
            </tfoot>
          </TableShell>
        )}
      </div>

      {suggestions.length > 0 ? (
        <div className="mt-6">
          <h3 className="text-sm font-semibold">
            Suggestions — moyenne des {AVERAGE_WINDOW_MONTHS} derniers mois
          </h3>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            Catégories sans budget ce mois-ci, avec ce qu&apos;elles coûtent en moyenne par
            mois (mois vides compris). « Utiliser » ouvre le formulaire prérempli — rien
            n&apos;est enregistré avant validation.
          </p>
          <ul className="mt-2 flex flex-col gap-1 text-sm">
            {suggestions.map((suggestion) => (
              <li
                key={`${suggestion.categoryId}|${suggestion.currency}`}
                className="flex flex-wrap items-center gap-2"
              >
                <span className="font-medium">{suggestion.categoryName}</span>
                <span className="text-zinc-500 dark:text-zinc-400">
                  {suggestion.kind === "EXPENSE" ? "dépense" : "recette"} ·{" "}
                  {suggestion.currency} · moyenne{" "}
                  {formatMoney({
                    amount: suggestion.monthlyAverage,
                    currency: suggestion.currency,
                  })}{" "}
                  ({suggestion.activeMonths}/{AVERAGE_WINDOW_MONTHS} mois actif
                  {suggestion.activeMonths > 1 ? "s" : ""})
                </span>
                <Link
                  href={`/budget?month=${monthKey}&tab=budgets&newBudgetCategory=${suggestion.categoryId}&newBudgetCurrency=${suggestion.currency}`}
                  className="rounded-md border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
                >
                  Utiliser
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Card>
  );
}
