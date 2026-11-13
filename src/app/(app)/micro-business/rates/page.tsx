import type Decimal from "decimal.js";
import Link from "next/link";
import {
  Card,
  EmptyState,
  Notice,
  PageHeader,
  TableShell,
  tdClass,
  thClass,
} from "@/components/ui";
import { ModuleDisabled } from "@/components/module-disabled";
import { requireUser } from "@/lib/auth/guard";
import { currentMonthKey } from "@/lib/dates";
import { formatMoney, type Currency } from "@/lib/money";
import { hasModule } from "@/modules/catalog/catalog";
import { canManageBusinessRecords } from "@/modules/identity/workspace";
import {
  canReadInternalRates,
  ratePeriodLabel,
} from "@/modules/micro-business/rates";
import {
  listBillingRates,
  listClients,
  listInternalCostRates,
} from "@/modules/micro-business/repository";
import { BillingRateForm } from "./billing-rate-form";
import { InternalRateForm } from "./internal-rate-form";
import { MicroBusinessTabs } from "../micro-business-tabs";

export const dynamic = "force-dynamic";

function hourly(rate: Decimal, currency: Currency): string {
  return `${formatMoney({ amount: rate, currency })} / h`;
}

/**
 * « Tarifs » — client billing rates and confidential internal cost rates.
 *
 * Both lists are change points: a row applies from its month until the next one. The
 * page never derives a rate for a month before the first entry — it simply has none.
 *
 * Internal rates are loaded only when the role holds `read-internal-rates` (owner
 * only for now). Without it the page does not query the table at all, so no value can
 * leak through a component, a log or a serialized prop.
 */
export default async function RatesPage() {
  const user = await requireUser();

  if (!hasModule(user.workspace, "micro-business")) {
    return <ModuleDisabled moduleKey="micro-business" workspace={user.workspace} />;
  }

  const canManage = canManageBusinessRecords(user.workspace.role);
  const canReadInternal = canReadInternalRates(user.workspace.role);

  const [clients, billingRates, internalRates] = await Promise.all([
    listClients(user.workspace.id),
    listBillingRates(user.workspace.id),
    canReadInternal ? listInternalCostRates(user.workspace.id) : Promise.resolve([]),
  ]);

  const activeClients = clients
    .filter((client) => !client.archived)
    .map((client) => ({ id: client.id, name: client.name }));
  const defaultMonth = currentMonthKey();

  return (
    <>
      <PageHeader
        title="Tarifs"
        description="Tarifs clients et coûts internes, tous deux datés par mois. Un tarif s'applique à partir du mois saisi, jusqu'au changement suivant ; avant le premier point de changement, aucun taux n'est supposé. Aucune devise n'est convertie et aucun montant déjà calculé n'est réécrit."
      />

      <MicroBusinessTabs current="/micro-business/rates" />

      {canManage ? null : (
        <Notice tone="info">
          Seuls le propriétaire et les administrateurs de l&apos;espace peuvent enregistrer
          des tarifs. Vous pouvez consulter les tarifs clients existants.
        </Notice>
      )}

      <Card
        title="Tarifs clients"
        description="Ce que le client paie par heure. Le tarif appartient au client, pas au projet : il s'applique à tous ses projets. Enregistrer le même client et le même mois corrige le point de changement."
      >
        <div className="flex flex-col gap-4">
          {canManage ? (
            <BillingRateForm clients={activeClients} defaultMonth={defaultMonth} />
          ) : null}

          {billingRates.length === 0 ? (
            <EmptyState
              title="Aucun tarif client"
              description="Ajoutez un premier point de changement pour rendre les heures facturables d'un client calculables."
            />
          ) : (
            <TableShell caption="Points de changement des tarifs clients">
              <thead>
                <tr>
                  <th scope="col" className={thClass}>
                    Client
                  </th>
                  <th scope="col" className={thClass}>
                    En vigueur à partir de
                  </th>
                  <th scope="col" className={thClass}>
                    Taux horaire
                  </th>
                </tr>
              </thead>
              <tbody>
                {billingRates.map((rate) => (
                  <tr key={rate.id}>
                    <td className={tdClass}>{rate.clientName}</td>
                    <td className={tdClass}>{ratePeriodLabel(rate.year, rate.month)}</td>
                    <td className={tdClass}>{hourly(rate.hourlyRate, rate.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </TableShell>
          )}
        </div>
      </Card>

      <Card
        title="Coûts internes (confidentiel)"
        description="Le coût horaire chargé du travail interne. Ce n'est jamais un tarif facturé au client, et les deux nombres ne sont jamais fusionnés."
      >
        {canReadInternal ? (
          <div className="flex flex-col gap-4">
            <Notice tone="warning">
              Confidentiel : ces montants ne sont visibles que par le propriétaire de
              l&apos;espace, jamais à côté des tarifs clients pour un autre rôle.
            </Notice>

            {canManage ? <InternalRateForm defaultMonth={defaultMonth} /> : null}

            {internalRates.length === 0 ? (
              <EmptyState
                title="Aucun coût interne"
                description="Ajoutez un premier point de changement pour suivre le coût chargé d'une heure."
              />
            ) : (
              <TableShell caption="Points de changement des coûts internes">
                <thead>
                  <tr>
                    <th scope="col" className={thClass}>
                      En vigueur à partir de
                    </th>
                    <th scope="col" className={thClass}>
                      Coût horaire chargé
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {internalRates.map((rate) => (
                    <tr key={rate.id}>
                      <td className={tdClass}>{ratePeriodLabel(rate.year, rate.month)}</td>
                      <td className={tdClass}>{hourly(rate.hourlyRate, rate.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </TableShell>
            )}
          </div>
        ) : (
          <Notice tone="info">
            Les coûts internes sont confidentiels et réservés au propriétaire de
            l&apos;espace. Aucun montant interne n&apos;est chargé pour votre rôle.
          </Notice>
        )}
      </Card>
    </>
  );
}
