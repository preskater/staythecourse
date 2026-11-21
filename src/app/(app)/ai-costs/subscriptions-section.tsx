import { Badge, Card, EmptyState, TableShell, tdClass, thClass } from "@/components/ui";
import { toDateOnlyString } from "@/lib/dates";
import { publicEnv } from "@/lib/env";
import { formatMoney, money, assertCurrency } from "@/lib/money";
import { listAllocationPolicies } from "@/modules/ai-costs/policy.repository";
import {
  listAiSubscriptions,
  readCoreFormula,
  readSubscriptionMetered,
} from "@/modules/ai-costs/subscription.repository";
import { SUBSCRIPTION_POLICY_KINDS, toSubscriptionRows } from "@/modules/ai-costs/subscriptions";
import { CancelSubscriptionButton } from "./cancel-subscription-button";
import { SubscriptionForm } from "./subscription-form";

/**
 * « Abonnements » tab (M12-05): the subscription register and the core formula of the
 * month, metered usage + subscriptions, both read from the ledger.
 */
export async function SubscriptionsSection({
  workspaceId,
  canWrite,
  cycle,
}: {
  workspaceId: string;
  canWrite: boolean;
  cycle: { start: Date; end: Date; today: Date };
}) {
  const [subscriptions, policies, formula] = await Promise.all([
    listAiSubscriptions(workspaceId),
    listAllocationPolicies(workspaceId),
    readCoreFormula(workspaceId, cycle.start, cycle.end),
  ]);
  const metered = await readSubscriptionMetered(workspaceId, subscriptions, cycle.today);
  const rows = toSubscriptionRows(
    subscriptions,
    metered,
    new Map(policies.map((policy) => [policy.id, policy.name])),
    cycle.today,
  );
  const usablePolicies = policies
    .filter((policy) => SUBSCRIPTION_POLICY_KINDS.includes(policy.kind))
    .map((policy) => ({ id: policy.id, name: policy.name }));
  const today = toDateOnlyString(cycle.today);
  const format = (amount: Parameters<typeof money>[0], currency: string) =>
    formatMoney(money(amount, assertCurrency(currency)));

  return (
    <>
      <Card title="Coût IA du mois" description="Usage mesuré + abonnements, par devise.">
        {formula.length === 0 ? (
          <EmptyState title="Aucune entrée ce mois-ci" />
        ) : (
          <TableShell caption="Coût IA du mois : usage mesuré et abonnements">
            <thead>
              <tr>
                <th scope="col" className={thClass}>Devise</th>
                <th scope="col" className={`${thClass} text-right`}>Usage mesuré</th>
                <th scope="col" className={`${thClass} text-right`}>Abonnements</th>
                <th scope="col" className={`${thClass} text-right`}>Total</th>
              </tr>
            </thead>
            <tbody>
              {formula.map((row) => (
                <tr key={row.currency}>
                  <td className={tdClass}>{row.currency}</td>
                  <td className={`${tdClass} text-right tabular-nums`}>{format(row.metered, row.currency)}</td>
                  <td className={`${tdClass} text-right tabular-nums`}>{format(row.subscriptions, row.currency)}</td>
                  <td className={`${tdClass} text-right font-semibold tabular-nums`}>
                    {format(row.metered.plus(row.subscriptions), row.currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </TableShell>
        )}
      </Card>

      {canWrite ? (
        <Card
          title="Nouvel abonnement"
          description="Chaque renouvellement est inscrit au registre (sièges × prix, « Calculé »), puis réparti par la politique choisie."
        >
          <SubscriptionForm
            today={today}
            defaultCurrency={publicEnv.NEXT_PUBLIC_DEFAULT_CURRENCY}
            policies={usablePolicies}
          />
        </Card>
      ) : null}

      <Card title="Abonnements">
        {rows.length === 0 ? (
          <EmptyState title="Aucun abonnement" description="Déclarez les offres et sièges IA payés chaque mois ou chaque année." />
        ) : (
          <TableShell caption="Registre des abonnements IA">
            <thead>
              <tr>
                <th scope="col" className={thClass}>Abonnement</th>
                <th scope="col" className={`${thClass} text-right`}>Coût</th>
                <th scope="col" className={thClass}>État</th>
                <th scope="col" className={thClass}>Enveloppe</th>
                <th scope="col" className={thClass}>Responsable</th>
                <th scope="col" className={thClass}>Répartition</th>
                <th scope="col" className={`${thClass} text-right`}>Inscrits</th>
                {canWrite ? <th scope="col" className={thClass}>Actions</th> : null}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className={`${tdClass} font-medium`}>{row.label}</td>
                  <td className={`${tdClass} text-right tabular-nums`}>
                    {row.cost}
                    <span className="block text-xs text-zinc-500 dark:text-zinc-400">{row.cadence}</span>
                  </td>
                  <td className={tdClass}>
                    {row.cancelled ? <Badge>{row.status}</Badge> : row.status}
                  </td>
                  <td className={`${tdClass} text-xs`}>{row.allowance}</td>
                  <td className={tdClass}>{row.owner}</td>
                  <td className={tdClass}>{row.policy}</td>
                  <td className={`${tdClass} text-right tabular-nums`}>{row.renewals}</td>
                  {canWrite ? (
                    <td className={tdClass}>
                      {row.cancelled ? null : (
                        <CancelSubscriptionButton subscriptionId={row.id} label={row.label} today={today} />
                      )}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </TableShell>
        )}
      </Card>
    </>
  );
}
