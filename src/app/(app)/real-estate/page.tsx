import Link from "next/link";
import {
  Badge,
  Card,
  EmptyState,
  Notice,
  PageHeader,
  StatCard,
  TableShell,
  tdClass,
  thClass,
} from "@/components/ui";
import { requireUser } from "@/lib/auth/guard";
import { ModuleDisabled } from "@/components/module-disabled";
import { hasModule } from "@/modules/catalog/catalog";
import { formatDateOnly, toDateOnlyString } from "@/lib/dates";
import { formatMoney, type Currency } from "@/lib/money";
import type Decimal from "decimal.js";
import { listTransactions } from "@/modules/budget/repository";
import {
  listLoans,
  listProperties,
  findLoan,
  findPropertyEvent,
  listPropertyEvents,
} from "@/modules/real-estate/repository";
import {
  computeLoanTotals,
  toLoanFormInitialValues,
} from "@/modules/real-estate/loans";
import type { PropertyOccupancy } from "@/modules/real-estate/domain";
import {
  filterPropertyEvents,
  PROPERTY_EVENT_STATUSES,
  toPropertyEventFormValues,
  type PropertyEventStatus,
} from "@/modules/real-estate/events";
import { computeSaleAnalysis } from "@/modules/real-estate/valuation";
import { CashflowForm, type TransactionOption } from "./cashflow-form";
import { PropertyForm } from "./property-form";
import { LoanForm } from "./loan-form";
import { DeleteLoanButton } from "./delete-loan-button";
import { RemovePropertyButton } from "./remove-property-button";
import { PropertyEventsSection } from "./events-section";

export const dynamic = "force-dynamic";

/** Enough recent operations to pick from without loading the whole history. */
const TRANSACTION_OPTION_LIMIT = 100;

const OCCUPANCY_LABELS: Record<PropertyOccupancy, string> = {
  RENTED: "Loué",
  VACANT: "Vacant",
  OWNER_OCCUPIED: "Occupé par le propriétaire",
  SEASONAL: "Saisonnier",
  OTHER: "Autre",
};

/** A financing figure that was never recorded reads "inconnu", never zero. */
function formatOptionalMoney(amount: Decimal | null, currency: Currency): string {
  if (!amount) {
    return "inconnu";
  }

  return formatMoney({ amount, currency });
}

/** Decimal strings for client components: a `Decimal` never crosses the boundary. */
function decimalText(amount: Decimal | null): string | null {
  return amount === null ? null : amount.toFixed(2);
}

export default async function RealEstatePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const editLoanId = typeof params.editLoan === "string" ? params.editLoan : null;
  const editEventId = typeof params.editEvent === "string" ? params.editEvent : null;
  const requestedEventProperty =
    typeof params.eventProperty === "string" ? params.eventProperty : "";
  const requestedEventStatus =
    typeof params.eventStatus === "string" ? params.eventStatus : "";

  const user = await requireUser();
  // A direct link explains the state instead of a 404, and reads nothing of the module.
  if (!hasModule(user.workspace, "real-estate")) {
    return <ModuleDisabled moduleKey="real-estate" workspace={user.workspace} />;
  }
  const [properties, recentTransactions, loans, allEvents] = await Promise.all([
    listProperties(user.workspace.id),
    // A cashflow entry can be linked to an operation recorded in the budget, when the
    // budget module is active in this workspace.
    hasModule(user.workspace, "budget")
      ? listTransactions(user.workspace.id, { take: TRANSACTION_OPTION_LIMIT })
      : [],
    listLoans(user.workspace.id),
    listPropertyEvents(user.workspace.id),
  ]);

  // An unknown filter value falls back to "all": a hand-edited link must never fail
  // the page or hide data silently.
  const eventPropertyFilter = properties.some(
    (property) => property.id === requestedEventProperty,
  )
    ? requestedEventProperty
    : "";
  const eventStatusFilter = PROPERTY_EVENT_STATUSES.includes(
    requestedEventStatus as PropertyEventStatus,
  )
    ? (requestedEventStatus as PropertyEventStatus)
    : "";

  const events = filterPropertyEvents(allEvents, {
    propertyId: eventPropertyFilter || null,
    status: eventStatusFilter || null,
  });

  // The edited loan and event are looked up owner-scoped: a foreign or unknown id
  // falls back to the creation form rather than revealing anything.
  const [editingLoan, editingEvent] = await Promise.all([
    editLoanId ? findLoan(user.workspace.id, editLoanId) : null,
    editEventId ? findPropertyEvent(user.workspace.id, editEventId) : null,
  ]);

  // Reduced to strings: the form is a client component and never receives a Decimal.
  const transactionOptions: TransactionOption[] = recentTransactions.map((transaction) => ({
    id: transaction.id,
    label: transaction.label,
    date: formatDateOnly(transaction.operationDate),
    amountText: formatMoney({ amount: transaction.amount, currency: transaction.currency }),
  }));

  const rentedCount = properties.filter((property) => property.occupancy === "RENTED").length;
  const vacantCount = properties.filter((property) => property.occupancy === "VACANT").length;
  const soldCount = properties.filter((property) => property.saleDate !== null).length;

  const propertyOptions = properties.map((property) => ({
    id: property.id,
    name: property.name,
  }));

  // Events carry an informational amount, so the form defaults its currency to the
  // property's own reference currency instead of assuming EUR.
  const eventPropertyOptions = properties.map((property) => ({
    id: property.id,
    name: property.name,
    currency: property.priceCurrency,
  }));

  const propertyNameById = new Map(properties.map((property) => [property.id, property.name]));

  // The removal panel needs the same projection as the detail page: the debt comes
  // from the loans already loaded above, and the sale formula is the module's own.
  const loansByProperty = new Map<string, typeof loans>();
  for (const loan of loans) {
    const grouped = loansByProperty.get(loan.propertyId) ?? [];
    grouped.push(loan);
    loansByProperty.set(loan.propertyId, grouped);
  }

  const propertyRows = properties.map((property) => {
    const analysis = computeSaleAnalysis({
      currency: property.priceCurrency,
      purchasePrice: property.purchasePrice,
      estimatedValue: property.estimatedValue,
      estimatedValueAsOf: property.estimatedValueAsOf,
      targetGainRate: property.targetGainRate,
      saleDate: property.saleDate,
      salePrice: property.salePrice,
      saleCosts: property.saleCosts,
      totals: {
        income: property.income,
        expenses: property.expenses,
        currency: property.currency,
      },
      totalsComplete: property.foreignCurrencyCashflows === 0,
      loans: loansByProperty.get(property.id) ?? [],
    });

    return {
      property,
      removal: {
        id: property.id,
        name: property.name,
        currency: property.priceCurrency,
        saleDate: property.saleDate ? toDateOnlyString(property.saleDate) : null,
        sale:
          property.saleDate && property.salePrice
            ? {
                saleDate: toDateOnlyString(property.saleDate),
                salePrice: property.salePrice.toFixed(2),
                saleCosts: property.saleCosts ? property.saleCosts.toFixed(2) : "0",
              }
            : null,
        netInvested: decimalText(analysis.netInvested),
        outstandingDebt: decimalText(analysis.outstandingDebt),
        unknownLoanBalances: analysis.unknownLoanBalances,
        foreignCurrencyLoans: analysis.foreignCurrencyLoans,
      },
    };
  });

  const loanCurrencies = Array.from(new Set(loans.map((loan) => loan.currency)));
  const financingTotals = loanCurrencies.map((currency) =>
    computeLoanTotals(
      loans.filter((loan) => loan.currency === currency),
      { currency },
    ),
  );

  return (
    <>
      <PageHeader
        title="Immobilier"
        description="Biens, charges et recettes. Un bien n'est pas supposé loué : son statut d'occupation est explicite."
        actions={
          <Link
            href="/api/export/properties"
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            Exporter en CSV
          </Link>
        }
      />

      <Card
        title="Saisie"
        description="Ajout manuel des biens et de leurs flux. Aucun bien n'est présumé loué."
      >
        <div className="flex flex-col gap-3">
          <details open>
            <summary className="cursor-pointer text-sm font-medium">Nouveau bien</summary>
            <div className="pt-3">
              <PropertyForm />
            </div>
          </details>

          <details>
            <summary className="cursor-pointer text-sm font-medium">Nouveau flux</summary>
            <div className="pt-3">
              <CashflowForm properties={propertyOptions} transactions={transactionOptions} />
            </div>
          </details>
        </div>
      </Card>

      <PropertyEventsSection
        title="Échéances et obligations"
        properties={eventPropertyOptions}
        events={events}
        today={new Date()}
        editEvent={editingEvent ? toPropertyEventFormValues(editingEvent) : null}
        filter={{ propertyId: eventPropertyFilter, status: eventStatusFilter }}
        basePath="/real-estate"
      />

      <Card
        title="Financement"
        description="Les prêts d'un bien : capital, taux, mensualité et assurance. Le financement est présenté à part et n'entre jamais dans les totaux d'exploitation."
      >
        <div className="flex flex-col gap-4">
          <details open={Boolean(editingLoan)}>
            <summary className="cursor-pointer text-sm font-medium">
              {editingLoan ? `Modifier le prêt « ${editingLoan.label} »` : "Nouveau prêt"}
            </summary>
            <div className="pt-3">
              {editingLoan ? (
                <p className="mb-2 text-xs">
                  <Link href="/real-estate" className="underline">
                    Annuler la modification
                  </Link>
                </p>
              ) : null}
              <LoanForm
                key={editingLoan?.id ?? "new"}
                properties={propertyOptions}
                loan={editingLoan ? toLoanFormInitialValues(editingLoan) : null}
              />
            </div>
          </details>

          {loans.length === 0 ? (
            <EmptyState
              title="Aucun financement enregistré"
              description="Ajoutez un prêt pour suivre le capital restant dû, le taux et la mensualité d'un bien. Ces montants restent séparés des charges et recettes."
            />
          ) : (
            <>
              <TableShell caption="Prêts rattachés aux biens">
                <thead>
                  <tr>
                    <th scope="col" className={thClass}>
                      Bien
                    </th>
                    <th scope="col" className={thClass}>
                      Prêt
                    </th>
                    <th scope="col" className={`${thClass} text-right`}>
                      Capital
                    </th>
                    <th scope="col" className={`${thClass} text-right`}>
                      Solde restant
                    </th>
                    <th scope="col" className={`${thClass} text-right`}>
                      Taux
                    </th>
                    <th scope="col" className={`${thClass} text-right`}>
                      Mensualité
                    </th>
                    <th scope="col" className={`${thClass} text-right`}>
                      Assurance
                    </th>
                    <th scope="col" className={`${thClass} text-right`}>
                      Durée
                    </th>
                    <th scope="col" className={thClass}>
                      Échéances
                    </th>
                    <th scope="col" className={thClass}>
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {loans.map((loan) => (
                    <tr key={loan.id}>
                      <td className={tdClass}>
                        {propertyNameById.get(loan.propertyId) ?? "Bien inconnu"}
                      </td>
                      <td className={tdClass}>{loan.label}</td>
                      <td className={`${tdClass} text-right tabular-nums`}>
                        {formatMoney({
                          amount: loan.initialPrincipal,
                          currency: loan.currency,
                        })}
                      </td>
                      <td className={`${tdClass} text-right tabular-nums`}>
                        {formatOptionalMoney(loan.outstandingBalance, loan.currency)}
                        {loan.balanceAsOf ? (
                          <span className="block text-xs text-zinc-500 dark:text-zinc-400">
                            au {formatDateOnly(loan.balanceAsOf)}
                          </span>
                        ) : null}
                      </td>
                      <td className={`${tdClass} text-right tabular-nums`}>
                        {loan.interestRate ? `${loan.interestRate.toFixed(2)} %` : "inconnu"}
                      </td>
                      <td className={`${tdClass} text-right tabular-nums`}>
                        {formatOptionalMoney(loan.paymentAmount, loan.currency)}
                      </td>
                      <td className={`${tdClass} text-right tabular-nums`}>
                        {formatOptionalMoney(loan.insuranceAmount, loan.currency)}
                      </td>
                      <td className={`${tdClass} text-right tabular-nums`}>
                        {loan.termMonths !== null ? `${loan.termMonths} mois` : "inconnu"}
                      </td>
                      <td className={tdClass}>
                        {loan.startDate || loan.endDate ? (
                          <span className="text-xs">
                            {loan.startDate ? formatDateOnly(loan.startDate) : "—"}
                            {" → "}
                            {loan.endDate ? formatDateOnly(loan.endDate) : "—"}
                          </span>
                        ) : (
                          <span className="text-zinc-500 dark:text-zinc-400">inconnu</span>
                        )}
                      </td>
                      <td className={tdClass}>
                        <span className="flex flex-col items-start gap-1">
                          <Link
                            href={`/real-estate?editLoan=${loan.id}`}
                            className="rounded-md border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
                          >
                            Modifier
                          </Link>
                          <DeleteLoanButton loanId={loan.id} label={loan.label} />
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </TableShell>

              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {financingTotals.map((total) => (
                  <StatCard
                    key={total.currency}
                    label={`Coût mensuel (${total.currency})`}
                    value={
                      total.monthlyCost
                        ? formatMoney({ amount: total.monthlyCost, currency: total.currency })
                        : "inconnu"
                    }
                    hint="Mensualités + assurances"
                  />
                ))}
                {financingTotals.map((total) => (
                  <StatCard
                    key={`${total.currency}-debt`}
                    label={`Dette restante (${total.currency})`}
                    value={
                      total.outstandingDebt
                        ? formatMoney({ amount: total.outstandingDebt, currency: total.currency })
                        : "inconnu"
                    }
                    hint={
                      total.unknownBalances > 0
                        ? `${total.unknownBalances} solde(s) non renseigné(s)`
                        : undefined
                    }
                  />
                ))}
              </div>
            </>
          )}

          <Notice tone="info">
            Le financement (capital, intérêts, assurance) est présenté à part : il ne compte
            ni dans les recettes ni dans les charges d&apos;exploitation du bien. Un solde
            restant dû non renseigné reste « inconnu », jamais zéro.
          </Notice>
        </div>
      </Card>

      {properties.length === 0 ? (
        <EmptyState
          title="Aucun bien enregistré"
          description="Ajoutez un bien pour suivre ses charges, ses recettes locatives éventuelles et ses échéances. Aucun bien n'est présumé loué."
        />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="Biens suivis" value={String(properties.length)} />
            <StatCard label="Loués" value={String(rentedCount)} />
            <StatCard label="Vacants" value={String(vacantCount)} />
            <StatCard label="Vendus" value={String(soldCount)} />
          </div>

          <Card
            title="Détail par bien"
            description="Cliquez sur un bien pour sa fiche, son historique et l'indicateur de cession. Les flux liés à une transaction ne sont comptés qu'une seule fois ; le financement (prêts) est suivi à part, ci-dessus."
          >
            <TableShell caption="Biens et flux rattachés">
              <thead>
                <tr>
                  <th scope="col" className={thClass}>
                    Bien
                  </th>
                  <th scope="col" className={thClass}>
                    Occupation
                  </th>
                  <th scope="col" className={thClass}>
                    Flux
                  </th>
                  <th scope="col" className={`${thClass} text-right`}>
                    Recettes
                  </th>
                  <th scope="col" className={`${thClass} text-right`}>
                    Charges
                  </th>
                  <th scope="col" className={`${thClass} text-right`}>
                    Solde
                  </th>
                  <th scope="col" className={thClass}>
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {propertyRows.map(({ property, removal }) => (
                  <tr key={property.id}>
                    <td className={tdClass}>
                      <Link
                        href={`/real-estate/${property.id}`}
                        className="font-medium underline-offset-2 hover:underline"
                      >
                        {property.name}
                      </Link>
                      {property.address ? (
                        <span className="block text-xs text-zinc-500 dark:text-zinc-400">
                          {property.address}
                        </span>
                      ) : null}
                      {property.purchaseDate ? (
                        <span className="block text-xs text-zinc-500 dark:text-zinc-400">
                          Acquis le {formatDateOnly(property.purchaseDate)}
                        </span>
                      ) : null}
                      {property.saleDate ? (
                        <span className="mt-1 block text-xs text-rose-700 dark:text-rose-400">
                          Vendu le {formatDateOnly(property.saleDate)}
                        </span>
                      ) : null}
                    </td>
                    <td className={tdClass}>
                      <Badge tone={property.occupancy === "RENTED" ? "positive" : "neutral"}>
                        {OCCUPANCY_LABELS[property.occupancy]}
                      </Badge>
                    </td>
                    <td className={tdClass}>
                      {property.cashflowCount === 0 ? (
                        <span className="text-zinc-500 dark:text-zinc-400">
                          Aucun flux enregistré
                        </span>
                      ) : (
                        <>
                          {`${property.cashflowCount} entrée${property.cashflowCount > 1 ? "s" : ""}`}
                          {property.foreignCurrencyCashflows > 0 ? (
                            <span className="block text-xs text-amber-700 dark:text-amber-300">
                              dont {property.foreignCurrencyCashflows} hors {property.currency},
                              exclu{property.foreignCurrencyCashflows > 1 ? "s" : ""}
                            </span>
                          ) : null}
                        </>
                      )}
                    </td>
                    <td className={`${tdClass} text-right tabular-nums`}>
                      {formatMoney({ amount: property.income, currency: property.currency })}
                    </td>
                    <td className={`${tdClass} text-right tabular-nums`}>
                      {formatMoney({ amount: property.expenses, currency: property.currency })}
                    </td>
                    <td
                      className={`${tdClass} text-right tabular-nums ${
                        property.net.isNegative() ? "text-rose-700 dark:text-rose-400" : ""
                      }`}
                    >
                      {formatMoney({ amount: property.net, currency: property.currency })}
                    </td>
                    <td className={tdClass}>
                      <span className="flex flex-col items-start gap-1">
                        <Link
                          href={`/real-estate/${property.id}`}
                          className="rounded-md border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
                        >
                          Fiche du bien
                        </Link>
                        <Link
                          href={`/real-estate/${property.id}#modifier`}
                          className="rounded-md border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
                        >
                          Modifier
                        </Link>
                        <RemovePropertyButton property={removal} />
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </TableShell>
          </Card>

          <Notice tone="info">
            Règle de comptage : un flux rattaché à une transaction reprend le montant de
            cette transaction et n&apos;enregistre pas de montant propre. Sans cette règle,
            la même somme apparaîtrait deux fois dans les totaux. Une échéance non réglée
            et dépassée est signalée dans le détail du bien.
          </Notice>
        </>
      )}
    </>
  );
}
