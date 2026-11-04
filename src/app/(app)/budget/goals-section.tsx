import Link from "next/link";
import { Fragment } from "react";
import type Decimal from "decimal.js";
import {
  Badge,
  Card,
  EmptyState,
  Notice,
  TableShell,
  tdClass,
  thClass,
} from "@/components/ui";
import { formatDateOnly, toDateOnlyString } from "@/lib/dates";
import { formatMoney, type Currency } from "@/lib/money";
import {
  GOAL_STATUS_LABELS,
  computeGoalProgress,
  summariseGoalTotals,
  toGoalFormInitialValues,
  type GoalProgress,
  type GoalRecord,
  type GoalStatus,
  type GoalTotals,
} from "@/modules/budget/goals";
import {
  findGoal,
  listAccounts,
  listGoalContributionsForOwner,
  listGoals,
  readAccountBalance,
  sumGoalContributions,
} from "@/modules/budget/repository";
import { DeleteGoalButton } from "./delete-goal-button";
import { GoalContributions, type GoalContributionRow } from "./goal-contributions";
import { GoalForm } from "./goal-form";

/** How many log entries the goals screen displays; the counters stay exact. */
const CONTRIBUTION_LIST_LIMIT = 500;

const STATUS_TONES: Record<GoalStatus, "neutral" | "positive" | "warning"> = {
  ACTIVE: "neutral",
  ACHIEVED: "positive",
  ABANDONED: "warning",
};

/** "30,0" — never "30.0": the interface is French, the stored value is a plain Decimal. */
const PERCENT_FORMAT = new Intl.NumberFormat("fr-FR", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

/** An unknown value reads as "—", never as 0,00 €. */
function UnknownCell() {
  return <span title="Donnée inconnue">—</span>;
}

/** One progress bar, capped at 100 %; shared by the row cell and the footer total. */
function ProgressBar({ percentage, reached }: { percentage: Decimal; reached: boolean }) {
  const width = Math.min(100, Math.max(0, percentage.toNumber()));

  return (
    <span className="flex items-center gap-2">
      <span
        className="block h-1.5 w-24 rounded-full bg-zinc-200 dark:bg-zinc-800"
        aria-hidden="true"
      >
        <span
          className={`block h-1.5 rounded-full ${
            reached ? "bg-emerald-600" : "bg-zinc-900 dark:bg-zinc-100"
          }`}
          style={{ width: `${width}%` }}
        />
      </span>
      <span className="text-xs tabular-nums">
        {PERCENT_FORMAT.format(percentage.toNumber())} %
      </span>
    </span>
  );
}

/** Amount and percentage, side by side, with a bar that caps at 100 %. */
function ProgressCell({ goal, progress }: { goal: GoalRecord; progress: GoalProgress }) {
  if (progress.kind === "UNKNOWN") {
    return (
      <span className="text-xs text-amber-700 dark:text-amber-400">{progress.reason}</span>
    );
  }

  return (
    <div className="flex min-w-44 flex-col gap-1">
      <span className="tabular-nums">
        {formatMoney({ amount: progress.current, currency: goal.currency })}{" "}
        <span className="text-zinc-500 dark:text-zinc-400">
          / {formatMoney({ amount: goal.targetAmount, currency: goal.currency })}
        </span>
      </span>
      <ProgressBar percentage={progress.percentage} reached={progress.reached} />
    </div>
  );
}

/**
 * Footer cell of the « Progression » column: the group's weighted accomplishment,
 * `Σcurrent ÷ Σtarget`, or "—" when one goal's progress is unknown (see
 * `summariseGoalTotals`). When several goals draw on the same linked account, the total
 * says so: its balance is counted once there, while every row keeps showing it in full.
 */
function TotalProgressCell({ totals }: { totals: GoalTotals }) {
  if (totals.percentage === null) {
    return (
      <span title="Au moins un objectif a une progression inconnue : l'avancement global serait faussé.">
        —
      </span>
    );
  }

  return (
    <div className="flex min-w-44 flex-col gap-1">
      <span className="tabular-nums">
        {formatMoney({ amount: totals.current, currency: totals.currency })}{" "}
        <span className="text-zinc-500 dark:text-zinc-400">
          / {formatMoney({ amount: totals.target, currency: totals.currency })}
        </span>
      </span>
      <ProgressBar
        percentage={totals.percentage}
        reached={totals.remaining.lessThanOrEqualTo(0)}
      />
      {totals.sharedAccount ? (
        <span
          className="text-xs text-zinc-500 dark:text-zinc-400"
          title="Plusieurs objectifs partagent un même compte lié : son solde n'est compté qu'une fois dans le total, alors que chaque montant cible reste compté."
        >
          Solde partagé compté une fois
        </span>
      ) : null}
    </div>
  );
}

/** What the deadline demands: the figure, its horizon, or the reason there is none. */
function ContributionCell({ progress, currency }: { progress: GoalProgress; currency: Currency }) {
  if (progress.kind === "UNKNOWN") {
    return <UnknownCell />;
  }

  if (progress.monthlyContribution === null) {
    return (
      <span className="text-xs text-zinc-600 dark:text-zinc-400">{progress.contributionNote}</span>
    );
  }

  return (
    <span className="flex flex-col">
      <span className="whitespace-nowrap tabular-nums">
        {formatMoney({ amount: progress.monthlyContribution, currency })}
      </span>
      <span className="text-xs text-zinc-500 dark:text-zinc-400">
        {progress.monthsLeft === 1 ? "sur 1 mois restant" : `sur ${progress.monthsLeft} mois restants`}
      </span>
    </span>
  );
}

/**
 * "Objectifs" tab: savings or repayment goals, their progress and what the deadline asks.
 *
 * The section reads its own data and documents its rules in place: a goal's current
 * amount comes from the recorded balance of a linked account (the signed sum of its
 * transactions), or from a manual starting amount **plus the logged contributions**
 * (`GoalContribution` rows — never ledger transactions). When neither is available, the
 * progress shows the reason instead of a zero — "nothing recorded" is not "nothing
 * saved". The monthly contribution is the remaining amount divided by the whole calendar
 * months left, rounded half-up on cents (documented in
 * `docs/architecture/overview.md`), and it is not defined once the deadline has passed
 * or the goal is reached. The footer keeps every target but counts a shared linked
 * account once: the money is one pot, the projects it funds are distinct.
 */
export async function GoalsSection({
  workspaceId,
  editGoalId,
}: {
  workspaceId: string;
  /** `?editGoal=`, an identifier to look up: a foreign one finds nothing. */
  editGoalId?: string;
}) {
  const [goals, accounts, editTarget, contributionSums, contributionLog] = await Promise.all([
    listGoals(workspaceId),
    listAccounts(workspaceId),
    editGoalId ? findGoal(workspaceId, editGoalId) : Promise.resolve(null),
    sumGoalContributions(workspaceId),
    listGoalContributionsForOwner(workspaceId, { take: CONTRIBUTION_LIST_LIMIT }),
  ]);

  // The log arrives owner-wide and bounded (most recent first); the per-goal view is
  // grouped here, and the exact counters come from the aggregate, never from the list.
  const contributionsByGoal = new Map<string, GoalContributionRow[]>();
  for (const contribution of contributionLog) {
    const goal = goals.find((candidate) => candidate.id === contribution.goalId);
    const list = contributionsByGoal.get(contribution.goalId) ?? [];
    list.push({
      id: contribution.id,
      amountLabel: goal
        ? formatMoney({ amount: contribution.amount, currency: goal.currency })
        : contribution.amount.toFixed(2),
      dateLabel: formatDateOnly(contribution.date),
      note: contribution.note,
    });
    contributionsByGoal.set(contribution.goalId, list);
  }

  // A stale or foreign identifier fills nothing and is reported, so the form never looks
  // like it silently lost the row.
  const goalEditing = editTarget;
  const goalEditTargetIsHidden = Boolean(editGoalId) && editTarget === null;

  // One aggregate per linked goal: an account with no recorded transaction yields `null`
  // — the unknown balance — while an account whose movements net to zero yields a real
  // 0,00 €, and the two must not be confused.
  const balances = await Promise.all(
    goals.map((goal) =>
      goal.accountId
        ? readAccountBalance(workspaceId, goal.accountId).then(({ transactionCount, balance }) =>
            transactionCount === 0 ? null : balance,
          )
        : Promise.resolve(null),
    ),
  );

  const rows = goals.map((goal, index) => ({
    goal,
    progress: computeGoalProgress(goal, balances[index] ?? null, {
      contributionSum: contributionSums.get(goal.id)?.total ?? null,
    }),
  }));

  const today = toDateOnlyString(new Date());
  const listHref = "/budget?tab=goals";

  // Footer of the goals table: every non-text column is aggregated per currency, the
  // percentage being the group's weighted accomplishment (see `summariseGoalTotals`).
  // Every goal adds its own target, but a linked account shared by several goals adds its
  // balance once: money set aside is counted once, the projects it funds stay separate.
  const totalRows = rows;

  const goalCountByCurrency = new Map<string, number>();
  for (const { goal } of rows) {
    goalCountByCurrency.set(goal.currency, (goalCountByCurrency.get(goal.currency) ?? 0) + 1);
  }

  const totalsByCurrency = new Map<string, GoalTotals>();
  for (const [currency, totals] of summariseGoalTotals(totalRows)) {
    totalsByCurrency.set(currency, {
      ...totals,
      goalCount: goalCountByCurrency.get(totals.currency) ?? totals.goalCount,
    });
  }

  return (
    <Card
      title="Objectifs"
      description="Un objectif est un montant cible dans une devise, à atteindre avant une échéance. Sa progression vient du solde enregistré d'un compte lié, ou d'un montant de départ complété par les contributions journalisées (des écritures de suivi, jamais des opérations de compte). Sans source, ou sans opération sur le compte lié, la progression est affichée comme inconnue, pas comme zéro. Le total additionne les montants cibles, mais ne compte qu'une fois le solde d'un compte partagé par plusieurs objectifs ; chaque ligne, elle, montre le solde du compte qui la couvre. La contribution mensuelle est le reste divisé par les mois entiers restants, arrondie au centime (au demi supérieur) ; elle n'est plus définie après l'échéance ni une fois l'objectif atteint. Aucune conversion entre devises."
      actions={
        <Link
          href="/api/export/goals"
          className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
        >
          Exporter en CSV
        </Link>
      }
    >
      {goalEditTargetIsHidden ? (
        <Notice tone="warning">
          L&apos;objectif demandé n&apos;existe plus, ou ne fait pas partie de vos données : le
          formulaire reste en mode création.
        </Notice>
      ) : null}

      {goalEditing ? (
        <div className="mt-3 flex flex-col gap-3">
          <p className="text-sm font-medium">Modifier l&apos;objectif « {goalEditing.name} »</p>
          <GoalForm
            key={goalEditing.id}
            accounts={accounts}
            editing={toGoalFormInitialValues(goalEditing)}
            cancelHref={listHref}
          />
        </div>
      ) : (
        <details open>
          <summary className="cursor-pointer text-sm font-medium">Nouvel objectif</summary>
          <div className="pt-3">
            <GoalForm accounts={accounts} />
          </div>
        </details>
      )}

      <div className="mt-4">
        {goals.length === 0 ? (
          <EmptyState
            title="Aucun objectif"
            description="Ce n'est pas un objectif à zéro : aucune ligne n'existe encore. Un objectif se définit ci-dessus, avec un montant cible et une échéance."
          />
        ) : (
          <TableShell caption="Objectifs et progression">
            <thead>
              <tr>
                <th scope="col" className={thClass}>
                  Objectif
                </th>
                <th scope="col" className={thClass}>
                  Statut
                </th>
                <th scope="col" className={thClass}>
                  Progression
                </th>
                <th scope="col" className={`${thClass} text-right`}>
                  Reste
                </th>
                <th scope="col" className={thClass}>
                  Contribution mensuelle
                </th>
                <th scope="col" className={thClass}>
                  Échéance
                </th>
                <th scope="col" className={thClass}>
                  Action
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ goal, progress }) => (
                <Fragment key={goal.id}>
                  <tr
                    className={
                      goalEditing?.id === goal.id ? "bg-amber-50 dark:bg-amber-950/30" : undefined
                    }
                  >
                    <td className={tdClass}>
                      <span className="flex flex-col">
                        <span className="font-medium">{goal.name}</span>
                        <span className="text-xs text-zinc-500 dark:text-zinc-400">
                          {goal.accountName
                            ? `Compte lié : ${goal.accountName} (${goal.currency})`
                            : goal.currentAmount === null &&
                                (contributionSums.get(goal.id)?.count ?? 0) === 0
                              ? `Devise ${goal.currency} · aucune source : progression inconnue`
                              : `Montant de départ + contributions (${goal.currency})`}
                        </span>
                      </span>
                    </td>
                  <td className={tdClass}>
                    <Badge tone={STATUS_TONES[goal.status]}>
                      {GOAL_STATUS_LABELS[goal.status]}
                    </Badge>
                  </td>
                  <td className={tdClass}>
                    <ProgressCell goal={goal} progress={progress} />
                  </td>
                  <td className={`${tdClass} whitespace-nowrap text-right tabular-nums`}>
                    {progress.kind === "KNOWN" ? (
                      formatMoney({ amount: progress.remaining, currency: goal.currency })
                    ) : (
                      <UnknownCell />
                    )}
                  </td>
                  <td className={tdClass}>
                    <ContributionCell progress={progress} currency={goal.currency} />
                  </td>
                  <td className={`${tdClass} whitespace-nowrap`}>
                    {formatDateOnly(goal.targetDate)}
                  </td>
                  <td className={tdClass}>
                    <div className="flex flex-col items-start gap-1">
                      <Link
                        href={`${listHref}&editGoal=${goal.id}`}
                        className="rounded-md border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
                      >
                        Modifier
                      </Link>
                      <DeleteGoalButton goalId={goal.id} label={goal.name} />
                    </div>
                  </td>
                </tr>

                {goal.accountId === null ? (
                  <tr>
                    <td colSpan={7} className="border-b border-zinc-100 pb-3 dark:border-zinc-800">
                      <GoalContributions
                        goalId={goal.id}
                        contributions={contributionsByGoal.get(goal.id) ?? []}
                        totalCount={contributionSums.get(goal.id)?.count ?? 0}
                        totalLabel={
                          (contributionSums.get(goal.id)?.count ?? 0) === 0
                            ? "aucune contribution"
                            : formatMoney({
                                amount: contributionSums.get(goal.id)!.total,
                                currency: goal.currency,
                              })
                        }
                        truncated={
                          (contributionsByGoal.get(goal.id)?.length ?? 0) <
                          (contributionSums.get(goal.id)?.count ?? 0)
                        }
                        today={today}
                      />
                    </td>
                  </tr>
                ) : null}
                </Fragment>
              ))}
            </tbody>
            <tfoot>
              {[...totalsByCurrency.values()].map((totals) => (
                <tr key={totals.currency}>
                  <th scope="row" className={`${tdClass} text-right align-middle font-semibold`}>
                    Total ({totals.currency})
                  </th>
                  <td className={`${tdClass} whitespace-nowrap text-xs text-zinc-600 dark:text-zinc-400`}>
                    {totals.goalCount} objectif{totals.goalCount > 1 ? "s" : ""}
                  </td>
                  <td className={tdClass}>
                    <TotalProgressCell totals={totals} />
                  </td>
                  <td className={`${tdClass} whitespace-nowrap text-right font-semibold tabular-nums`}>
                    {totals.complete ? (
                      formatMoney({ amount: totals.remaining, currency: totals.currency })
                    ) : (
                      <span title="Au moins un objectif a une progression inconnue : le total serait incomplet.">
                        —
                      </span>
                    )}
                  </td>
                  <td className={`${tdClass} whitespace-nowrap font-semibold tabular-nums`}>
                    {totals.monthlyContribution !== null ? (
                      formatMoney({
                        amount: totals.monthlyContribution,
                        currency: totals.currency,
                      })
                    ) : (
                      <span title="Au moins un objectif a une contribution mensuelle non définie (échéance passée).">
                        —
                      </span>
                    )}
                  </td>
                  <td className={`${tdClass} whitespace-nowrap font-semibold`}>
                    <span
                      className="text-xs text-zinc-500 dark:text-zinc-400"
                      title="Échéance la plus proche du groupe"
                    >
                      {formatDateOnly(totals.nextDeadline)}
                    </span>
                  </td>
                  <td className={tdClass} />
                </tr>
              ))}
            </tfoot>
          </TableShell>
        )}
      </div>
    </Card>
  );
}
