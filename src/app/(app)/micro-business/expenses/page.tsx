import Link from "next/link";
import {
  Card,
  EmptyState,
  Notice,
  PageHeader,
  StatCard,
  TableShell,
  tdClass,
  thClass,
} from "@/components/ui";
import { ModuleDisabled } from "@/components/module-disabled";
import { requireUser } from "@/lib/auth/guard";
import { formatDateOnly, toDateOnlyString, todayDateOnly } from "@/lib/dates";
import { publicEnv } from "@/lib/env";
import { formatMoney } from "@/lib/money";
import { hasModule } from "@/modules/catalog/catalog";
import { RECURRENCE_FREQUENCY_LABELS } from "@/modules/budget/recurrence";
import { canManageBusinessRecords } from "@/modules/identity/workspace";
import {
  BUSINESS_EXPENSE_KIND_LABELS,
  upcomingBusinessExpenses,
  upcomingExpenseTotals,
  type BusinessExpenseRecord,
} from "@/modules/micro-business/expenses";
import { listBusinessExpenses } from "@/modules/micro-business/repository";
import { DeleteExpenseButton } from "./delete-expense-button";
import { BusinessExpenseForm } from "./expense-form";

export const dynamic = "force-dynamic";

/** The window shown below the definitions: the current month plus the next eleven. */
const UPCOMING_MONTHS = 12;

function periodLabel(expense: BusinessExpenseRecord): string {
  const start = formatDateOnly(expense.startDate);
  return expense.endDate === null
    ? `${start} → sans fin`
    : `${start} → ${formatDateOnly(expense.endDate)}`;
}

/**
 * « Charges » — recurring business expenses, obligations and planning reserves.
 *
 * Nothing here writes to the budget: the upcoming renewals are computed on read from
 * the cadence and the start date, so re-rendering the page can never duplicate one.
 * Every amount is labelled as a planning estimate; this is not tax advice and no
 * payment is made.
 */
export default async function ExpensesPage() {
  const user = await requireUser();

  if (!hasModule(user.workspace, "micro-business")) {
    return <ModuleDisabled moduleKey="micro-business" workspace={user.workspace} />;
  }

  const canManage = canManageBusinessRecords(user.workspace.role);
  const expenses = await listBusinessExpenses(user.workspace.id);

  const asOf = todayDateOnly(publicEnv.NEXT_PUBLIC_DEFAULT_TIME_ZONE);
  const today = toDateOnlyString(asOf);
  const upcoming = upcomingBusinessExpenses(expenses, asOf, UPCOMING_MONTHS);
  const totals = upcomingExpenseTotals(upcoming);

  return (
    <>
      <PageHeader
        title="Charges"
        description="Charges récurrentes, obligations et enveloppes de réserve. Chaque montant est une estimation de planification : aucun paiement n'est effectué, rien n'est écrit dans le budget, et ces enveloppes ne constituent pas un conseil fiscal."
        actions={
          <Link href="/micro-business" className="text-xs underline">
            ← Micro-entreprise
          </Link>
        }
      />

      <Notice tone="warning">
        Montants de planification uniquement. Les échéances à venir sont calculées à
        partir de la cadence et de la date de début ; elles ne créent aucune opération.
      </Notice>

      {canManage ? null : (
        <Notice tone="info">
          Seuls le propriétaire et les administrateurs de l&apos;espace peuvent créer ou
          supprimer une charge récurrente. Vous pouvez consulter la planification
          existante.
        </Notice>
      )}

      {canManage ? (
        <Card
          title="Nouvelle charge récurrente"
          description="La première échéance fixe le jour du mois (ramené au dernier jour des mois plus courts) et le mois de départ de la cadence. La date de fin est incluse et peut rester vide."
        >
          <BusinessExpenseForm today={today} />
        </Card>
      ) : null}

      <Card
        title="Charges et obligations planifiées"
        description="Les définitions décrivent la série ; aucune occurrence n'est enregistrée. Supprimer une définition la retire de la planification future, sans réécrire un historique qui n'existe pas."
      >
        {expenses.length === 0 ? (
          <EmptyState
            title="Aucune charge récurrente"
            description="Ajoutez les renouvellements de logiciels, les prestataires, l'assurance ou une enveloppe de réserve pour les voir arriver avant la trésorerie."
          />
        ) : (
          <TableShell caption="Charges récurrentes et obligations">
            <thead>
              <tr>
                <th scope="col" className={thClass}>
                  Charge
                </th>
                <th scope="col" className={thClass}>
                  Type
                </th>
                <th scope="col" className={thClass}>
                  Montant
                </th>
                <th scope="col" className={thClass}>
                  Cadence
                </th>
                <th scope="col" className={thClass}>
                  Période
                </th>
                {canManage ? (
                  <th scope="col" className={thClass}>
                    Actions
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {expenses.map((expense) => (
                <tr key={expense.id}>
                  <td className={tdClass}>
                    <span className="font-medium">{expense.label}</span>
                    {expense.vendor ? (
                      <span className="block text-xs text-zinc-500 dark:text-zinc-400">
                        {expense.vendor}
                      </span>
                    ) : null}
                    {expense.notes ? (
                      <span className="block max-w-64 truncate text-xs text-zinc-500 dark:text-zinc-400">
                        {expense.notes}
                      </span>
                    ) : null}
                  </td>
                  <td className={tdClass}>{BUSINESS_EXPENSE_KIND_LABELS[expense.kind]}</td>
                  <td className={tdClass}>
                    {formatMoney({ amount: expense.amount, currency: expense.currency })}
                  </td>
                  <td className={tdClass}>{RECURRENCE_FREQUENCY_LABELS[expense.frequency]}</td>
                  <td className={tdClass}>{periodLabel(expense)}</td>
                  {canManage ? (
                    <td className={tdClass}>
                      <DeleteExpenseButton expenseId={expense.id} label={expense.label} />
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </TableShell>
        )}
      </Card>

      <Card
        title={`Prochains ${UPCOMING_MONTHS} mois`}
        description="Échéances calculées, de la date du jour à la fin de la fenêtre. Une échéance tombée aujourd'hui est incluse ; une échéance passée ne l'est plus. Aucune devise n'est convertie."
      >
        {upcoming.length === 0 ? (
          <EmptyState
            title="Aucune échéance à venir"
            description="Aucune série ne produit d'échéance dans cette fenêtre. Vérifiez les dates de début et de fin des définitions."
          />
        ) : (
          <div className="flex flex-col gap-4">
            <div className="grid gap-3 sm:grid-cols-3">
              {totals.map((total) => (
                <StatCard
                  key={total.currency}
                  label={`À venir · ${total.currency}`}
                  value={formatMoney({
                    amount: total.total,
                    currency: total.currency,
                  })}
                  hint={`${total.count} échéance${total.count > 1 ? "s" : ""} sur ${UPCOMING_MONTHS} mois.`}
                />
              ))}
            </div>

            <TableShell caption="Échéances à venir">
              <thead>
                <tr>
                  <th scope="col" className={thClass}>
                    Échéance
                  </th>
                  <th scope="col" className={thClass}>
                    Charge
                  </th>
                  <th scope="col" className={thClass}>
                    Type
                  </th>
                  <th scope="col" className={thClass}>
                    Montant prévu
                  </th>
                </tr>
              </thead>
              <tbody>
                {upcoming.map(({ expense, date }) => (
                  <tr key={`${expense.id}-${date.toISOString()}`}>
                    <td className={tdClass}>{formatDateOnly(date)}</td>
                    <td className={tdClass}>
                      {expense.label}
                      {expense.vendor ? (
                        <span className="block text-xs text-zinc-500 dark:text-zinc-400">
                          {expense.vendor}
                        </span>
                      ) : null}
                    </td>
                    <td className={tdClass}>{BUSINESS_EXPENSE_KIND_LABELS[expense.kind]}</td>
                    <td className={tdClass}>
                      {formatMoney({ amount: expense.amount, currency: expense.currency })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </TableShell>
          </div>
        )}
      </Card>
    </>
  );
}
