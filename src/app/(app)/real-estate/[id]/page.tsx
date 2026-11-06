import Link from "next/link";
import { notFound } from "next/navigation";
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
import type { PropertyOccupancy } from "@/modules/real-estate/domain";
import { toPropertyEventFormValues } from "@/modules/real-estate/events";
import {
  findPropertyEvent,
  getPropertyDetail,
  listPropertyEvents,
} from "@/modules/real-estate/repository";
import {
  availableKpiYears,
  computePropertyKpis,
  KPI_PERIOD_TRAILING,
  kpiPeriodLabel,
  resolveKpiPeriod,
  type KpiFigure,
  type KpiUnavailableReason,
} from "@/modules/real-estate/kpis";
import {
  buildPropertyHistory,
  propertyHistoryKindLabel,
  type PropertyHistoryEvent,
} from "@/modules/real-estate/history";
import type { SaleStatus } from "@/modules/real-estate/valuation";
import { PropertyForm, type PropertyFormValues } from "../property-form";
import { SaleForm, type SaleFormValues } from "../sale-form";
import { RemovePropertyButton } from "../remove-property-button";
import { ValuationForm } from "../valuation-form";
import { PropertyEventsSection } from "../events-section";

export const dynamic = "force-dynamic";

const OCCUPANCY_LABELS: Record<PropertyOccupancy, string> = {
  RENTED: "Loué",
  VACANT: "Vacant",
  OWNER_OCCUPIED: "Occupé par le propriétaire",
  SEASONAL: "Saisonnier",
  OTHER: "Autre",
};

const SALE_STATUS_LABELS: Record<SaleStatus, string> = {
  SOLD: "Vendu",
  NO_ESTIMATE: "Valeur estimée à renseigner",
  UNKNOWN: "Données incomplètes",
  BELOW_TARGET: "Sous l'objectif",
  TARGET_REACHED: "Objectif atteint",
};

/** A figure that was never recorded reads "inconnu", never zero. */
function formatOptionalMoney(amount: Decimal | null, currency: Currency): string {
  return amount === null ? "inconnu" : formatMoney({ amount, currency });
}

/** Why an indicator is unknown, in the words the card shows under it. */
const KPI_REASON_LABELS: Record<KpiUnavailableReason, string> = {
  NO_DATA: "aucun flux enregistré sur la période",
  INCOMPLETE_PERIOD: "année en cours : la période n'est pas complète",
  NO_PURCHASE_PRICE: "prix d'acquisition non renseigné",
  CURRENCY_MISMATCH: "flux dans une autre devise, exclus du calcul",
  LOAN_WITHOUT_PAYMENT: "mensualité d'un prêt non renseignée",
  FOREIGN_CURRENCY_LOAN: "prêt dans une autre devise, jamais converti",
};

const KPI_PERCENT_FORMAT = new Intl.NumberFormat("fr-FR", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function formatKpiPercent(figure: KpiFigure): string {
  return figure.value === null
    ? "non calculable"
    : `${KPI_PERCENT_FORMAT.format(figure.value.toNumber())} %`;
}

function formatKpiMoney(figure: KpiFigure, currency: Currency): string {
  return figure.value === null ? "inconnu" : formatMoney({ amount: figure.value, currency });
}

/** The formula when the figure is known, the reason when it is not. */
function kpiReasonLabel(figure: KpiFigure): string | null {
  return figure.reason === null ? null : KPI_REASON_LABELS[figure.reason];
}

function kpiHint(figure: KpiFigure, formula: string): string {
  return kpiReasonLabel(figure) ?? formula;
}

function decimalText(amount: Decimal | null): string | null {
  return amount === null ? null : amount.toFixed(2);
}

function historyAmount(event: PropertyHistoryEvent): string {
  if (event.amount === null) {
    return "inconnu";
  }

  const text = formatMoney({ amount: event.amount, currency: event.currency });

  if (event.direction === "INFLOW") {
    return `+ ${text}`;
  }

  if (event.direction === "OUTFLOW") {
    return `− ${text}`;
  }

  return text;
}

export default async function PropertyDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const user = await requireUser();
  // A direct link explains the state instead of a 404, and reads nothing of the module.
  if (!hasModule(user.workspace, "real-estate")) {
    return <ModuleDisabled moduleKey="real-estate" workspace={user.workspace} />;
  }
  const property = await getPropertyDetail(user.workspace.id, id);

  if (!property) {
    notFound();
  }

  const editEventId = typeof query.editEvent === "string" ? query.editEvent : null;
  const [propertyEvents, requestedEvent] = await Promise.all([
    listPropertyEvents(user.workspace.id, { propertyId: property.id }),
    editEventId ? findPropertyEvent(user.workspace.id, editEventId) : null,
  ]);
  // An event from another property is ignored rather than edited from this page.
  const editingEvent =
    requestedEvent && requestedEvent.propertyId === property.id ? requestedEvent : null;

  const analysis = property.analysis;
  const currency = property.priceCurrency;

  // The indicators are computed server-side for one explicit window; a hand-edited
  // period falls back to the rolling window instead of failing the page.
  const now = new Date();
  const kpiPeriod = resolveKpiPeriod(
    typeof query.period === "string" ? query.period : null,
    now,
  );
  const kpis = computePropertyKpis({
    currency,
    occupancy: property.occupancy,
    purchasePrice: property.purchasePrice,
    cashflows: property.cashflows,
    loans: property.loans,
    period: kpiPeriod,
  });
  const kpiYearOptions = availableKpiYears({
    purchaseDate: property.purchaseDate,
    cashflows: property.cashflows,
    loans: property.loans,
    now,
  });
  const kpiPeriodOptions = [
    { value: KPI_PERIOD_TRAILING, label: "12 derniers mois" },
    ...kpiYearOptions.map((year) => ({ value: String(year), label: `Année ${year}` })),
  ];

  const kpiFinancingHint =
    kpis.financingCost.value === null
      ? kpiReasonLabel(kpis.financingCost) ?? "coût du financement inconnu"
      : `Coût du financement sur la période : ${formatMoney({
          amount: kpis.financingCost.value,
          currency,
        })}`;

  const formValues: PropertyFormValues = {
    id: property.id,
    name: property.name,
    address: property.address ?? "",
    occupancy: property.occupancy,
    currency: property.priceCurrency,
    purchaseDate: property.purchaseDate ? toDateOnlyString(property.purchaseDate) : "",
    purchasePrice: property.purchasePrice ? property.purchasePrice.toFixed(2) : "",
    estimatedValue: property.estimatedValue ? property.estimatedValue.toFixed(2) : "",
    estimatedValueAsOf: property.estimatedValueAsOf
      ? toDateOnlyString(property.estimatedValueAsOf)
      : "",
    targetGainRate: property.targetGainRate.toFixed(2),
    notes: property.notes ?? "",
  };

  const saleFormValues: SaleFormValues | null = analysis.sale
    ? {
        saleDate: toDateOnlyString(analysis.sale.date),
        salePrice: analysis.sale.price ? analysis.sale.price.toFixed(2) : "",
        saleCosts: analysis.sale.costs ? analysis.sale.costs.toFixed(2) : "0",
      }
    : null;

  const history = buildPropertyHistory({
    currency,
    purchaseDate: property.purchaseDate,
    purchasePrice: property.purchasePrice,
    estimatedValue: property.estimatedValue,
    estimatedValueAsOf: property.estimatedValueAsOf,
    saleDate: property.saleDate,
    salePrice: property.salePrice,
    cashflows: property.cashflows,
    loans: property.loans,
    valuations: property.valuations,
  });

  const removable = {
    id: property.id,
    name: property.name,
    currency,
    saleDate: property.saleDate ? toDateOnlyString(property.saleDate) : null,
    sale: saleFormValues,
    netInvested: decimalText(analysis.netInvested),
    outstandingDebt: decimalText(analysis.outstandingDebt),
    unknownLoanBalances: analysis.unknownLoanBalances,
    foreignCurrencyLoans: analysis.foreignCurrencyLoans,
  };

  return (
    <>
      <PageHeader
        title={property.name}
        description={
          <>
            {OCCUPANCY_LABELS[property.occupancy]}
            {property.address ? ` · ${property.address}` : ""}
            {property.saleDate ? ` · vendu le ${formatDateOnly(property.saleDate)}` : ""}
          </>
        }
        actions={
          <Link
            href="/real-estate"
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            ← Tous les biens
          </Link>
        }
      />

      <div className="flex flex-wrap gap-2">
        <Badge tone={property.occupancy === "RENTED" ? "positive" : "neutral"}>
          {OCCUPANCY_LABELS[property.occupancy]}
        </Badge>
        {property.saleDate ? <Badge tone="negative">Vendu</Badge> : null}
        {analysis.status === "SOLD" ? null : (
          <Badge tone={analysis.status === "TARGET_REACHED" ? "positive" : "warning"}>
            {SALE_STATUS_LABELS[analysis.status]}
          </Badge>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard
          label={`Prix d'acquisition (${currency})`}
          value={formatOptionalMoney(property.purchasePrice, currency)}
          hint={property.purchaseDate ? `Acquis le ${formatDateOnly(property.purchaseDate)}` : undefined}
        />
        <StatCard
          label={`Recettes (${property.currency})`}
          value={formatMoney({ amount: property.income, currency: property.currency })}
        />
        <StatCard
          label={`Charges (${property.currency})`}
          value={formatMoney({ amount: property.expenses, currency: property.currency })}
        />
        <StatCard
          label={`Solde d'exploitation (${property.currency})`}
          value={formatMoney({ amount: property.net, currency: property.currency })}
          tone={property.net.isNegative() ? "negative" : "neutral"}
        />
        <StatCard
          label={`Capital net engagé (${currency})`}
          value={formatOptionalMoney(analysis.netInvested, currency)}
          hint="Prix d'acquisition + charges − recettes"
        />
        <StatCard
          label={`Dette restante (${currency})`}
          value={formatOptionalMoney(analysis.outstandingDebt, currency)}
          hint={
            analysis.unknownLoanBalances > 0
              ? `${analysis.unknownLoanBalances} prêt(s) sans solde : dette inconnue`
              : analysis.foreignCurrencyLoans > 0
                ? "Prêt(s) dans une autre devise : aucune conversion"
                : "Somme des soldes de prêts enregistrés"
          }
        />
      </div>

      <Card
        id="indicateurs"
        title="Indicateurs de performance"
        description={
          <>
            Calculés uniquement sur les montants enregistrés du bien, sur une fenêtre de
            douze mois — fenêtre affichée : <strong>{kpiPeriodLabel(kpiPeriod)}</strong>.
            Aucune donnée de marché, aucune extrapolation.
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <nav
            aria-label="Période des indicateurs"
            className="flex flex-wrap items-center gap-2 text-sm"
          >
            {kpiPeriodOptions.map((option) => {
              const active =
                kpiPeriod.kind === "CALENDAR_YEAR"
                  ? option.value === String(kpiPeriod.year)
                  : option.value === KPI_PERIOD_TRAILING;

              return (
                <Link
                  key={option.value}
                  href={`/real-estate/${property.id}?period=${option.value}#indicateurs`}
                  aria-current={active ? "true" : undefined}
                  className={
                    active
                      ? "rounded-full bg-zinc-900 px-3 py-1 text-white dark:bg-zinc-100 dark:text-zinc-900"
                      : "rounded-full border border-zinc-300 px-3 py-1 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
                  }
                >
                  {option.label}
                </Link>
              );
            })}
          </nav>

          {kpis.cashflowCount === 0 ? (
            <EmptyState
              title={`Aucun flux sur ${kpiPeriodLabel(kpiPeriod)}`}
              description={
                kpis.outsidePeriodCashflows > 0
                  ? `Rien n'est daté dans cette fenêtre, alors que ${kpis.outsidePeriodCashflows} flux existent sur une autre période. Aucun indicateur n'est calculé : ce n'est pas un résultat à zéro.`
                  : "Aucun flux n'est encore enregistré pour ce bien. Les indicateurs apparaîtront dès qu'une recette ou une charge sera datée dans la fenêtre."
              }
            />
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <StatCard
                  label={`Recettes locatives (${kpis.currency})`}
                  value={formatMoney({
                    amount: kpis.rentalIncome,
                    currency: kpis.currency,
                  })}
                  hint={`${kpis.monthsWithRent} mois avec un loyer enregistré sur ${kpis.period.months}`}
                />
                <StatCard
                  label={`Charges d'exploitation (${kpis.currency})`}
                  value={formatMoney({
                    amount: kpis.operatingExpenses,
                    currency: kpis.currency,
                  })}
                  hint={`${kpis.inCurrencyCashflows} flux comptés dans la devise du bien`}
                />
                <StatCard
                  label={`Résultat d'exploitation (${kpis.currency})`}
                  value={formatMoney({ amount: kpis.noi, currency: kpis.currency })}
                  tone={kpis.noi.isNegative() ? "negative" : "neutral"}
                  hint="Recettes locatives − charges d'exploitation"
                />
                <StatCard
                  label={`Flux après financement (${kpis.currency})`}
                  value={formatKpiMoney(kpis.cashflowAfterFinancing, currency)}
                  tone={
                    kpis.cashflowAfterFinancing.value === null
                      ? "neutral"
                      : kpis.cashflowAfterFinancing.value.isNegative()
                        ? "negative"
                        : "positive"
                  }
                  hint={kpiFinancingHint}
                />
                <StatCard
                  label="Rendement brut"
                  value={formatKpiPercent(kpis.grossYield)}
                  tone={
                    kpis.grossYield.value !== null && kpis.grossYield.value.greaterThan(0)
                      ? "positive"
                      : "neutral"
                  }
                  hint={kpiHint(kpis.grossYield, "Recettes locatives ÷ prix d'acquisition")}
                />
                <StatCard
                  label="Rendement net"
                  value={formatKpiPercent(kpis.netYield)}
                  tone={
                    kpis.netYield.value === null
                      ? "neutral"
                      : kpis.netYield.value.isNegative()
                        ? "negative"
                        : "positive"
                  }
                  hint={kpiHint(kpis.netYield, "Résultat d'exploitation ÷ prix d'acquisition")}
                />
                <StatCard
                  label="Occupation"
                  value={OCCUPANCY_LABELS[kpis.occupancy]}
                  hint="Statut déclaré du bien ; aucun bail n'est enregistré."
                />
              </div>

              {kpis.currencyMismatch ? (
                <Notice tone="warning">
                  {`${kpis.foreignCurrencyCashflows} flux hors ${kpis.currency} dans cette fenêtre : exclus des sommes et des rendements, aucune conversion n'est appliquée.`}
                </Notice>
              ) : null}

              {kpis.unresolvedCashflows > 0 ? (
                <Notice tone="warning">
                  {kpis.unresolvedCashflows} flux datés n&apos;ont ni montant ni transaction
                  liée : ils ne peuvent pas entrer dans un total.
                </Notice>
              ) : null}

              {kpis.loansWithoutStartDate > 0 ? (
                <Notice tone="info">
                  {kpis.loansWithoutStartDate} prêt(s) sans date de début : leur coût est
                  compté sur les {kpis.period.months} mois de la fenêtre.
                </Notice>
              ) : null}

              {kpis.period.complete ? null : (
                <Notice tone="info">
                  L&apos;année en cours n&apos;est pas terminée : les sommes sont partielles
                  et les rendements ne sont pas calculés plutôt que d&apos;être extrapolés.
                </Notice>
              )}

              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                Recettes locatives = somme des entrées de type recette datées dans la
                fenêtre (date de règlement, sinon d&apos;échéance, sinon de saisie) ; charges
                = somme des sorties ; résultat d&apos;exploitation = recettes − charges ;
                flux après financement = résultat − mensualités et assurances des prêts
                actifs sur la fenêtre ; rendements = recettes (ou résultat) ÷ prix
                d&apos;acquisition. Un flux lié à une transaction n&apos;est compté
                qu&apos;une fois, et un prêt ne compte jamais dans les charges
                d&apos;exploitation.
              </p>
            </>
          )}
        </div>
      </Card>

      <Card
        title="Quand vendre, à quel prix ?"
        description="Indicateur déterministe, calculé uniquement avec vos montants enregistrés. Il ne prévoit pas les prix de marché et ne constitue pas un conseil financier."
      >
        <div className="flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <StatCard
              label={`Seuil de cession (${currency})`}
              value={formatOptionalMoney(analysis.breakEvenPrice, currency)}
              hint="Prix de vente sans perte : capital net engagé + dette, hors frais."
            />
            <StatCard
              label={`Prix cible (+${property.targetGainRate.toFixed(2)} %) (${currency})`}
              value={formatOptionalMoney(analysis.targetPrice, currency)}
              hint="Seuil + objectif de plus-value × capital net engagé."
            />
            <StatCard
              label={`Valeur estimée (${currency})`}
              value={formatOptionalMoney(analysis.estimatedValue, currency)}
              hint={
                analysis.estimatedValueAsOf
                  ? `Estimation du ${formatDateOnly(analysis.estimatedValueAsOf)}`
                  : "Aucune estimation datée enregistrée."
              }
            />
            <StatCard
              label={`Équité (${currency})`}
              value={formatOptionalMoney(analysis.estimatedEquity, currency)}
              hint="Dernière valorisation − dette restante. Inconnue si l'une des deux données manque."
            />
            <StatCard
              label={`Gain estimé à cette valeur (${currency})`}
              value={formatOptionalMoney(analysis.estimatedGain, currency)}
              tone={
                analysis.estimatedGain === null
                  ? "neutral"
                  : analysis.estimatedGain.lessThan(0)
                    ? "negative"
                    : "positive"
              }
              hint="Valeur nette estimée − capital net engagé, hors frais de cession."
            />
            <StatCard
              label={`Écart au prix cible (${currency})`}
              value={
                analysis.gapToTarget === null
                  ? "inconnu"
                  : analysis.gapToTarget.greaterThan(0)
                    ? `il manque ${formatMoney({ amount: analysis.gapToTarget, currency })}`
                    : `dépassé de ${formatMoney({
                        amount: analysis.gapToTarget.abs(),
                        currency,
                      })}`
              }
              tone={
                analysis.gapToTarget === null
                  ? "neutral"
                  : analysis.gapToTarget.greaterThan(0)
                    ? "warning"
                    : "positive"
              }
              hint="Prix cible − valeur estimée, hors frais de cession."
            />
          </div>

          {analysis.status === "NO_ESTIMATE" ? (
            <Notice tone="info">
              Renseignez une valeur estimée (et sa date) pour situer le bien par rapport
              au prix cible.
            </Notice>
          ) : null}

          {analysis.status === "UNKNOWN" ? (
            <Notice tone="warning">
              L&apos;indicateur reste incomplet : le prix d&apos;acquisition, le solde
              d&apos;un prêt ou la devise des flux manque. Une donnée absente reste
              « inconnue », jamais zéro.
            </Notice>
          ) : null}

          {analysis.currencyMismatch ? (
            <Notice tone="warning">
              Une partie des flux de ce bien n&apos;est pas dans la devise de ses prix (
              {currency}) : aucun total n&apos;est converti, donc le capital net engagé et
              les indicateurs qui en dépendent restent inconnus.
            </Notice>
          ) : null}

          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Formules : capital net engagé = prix d&apos;acquisition + charges cumulées −
            recettes cumulées ; seuil de cession = capital net engagé + dette restante ;
            prix cible = seuil + objectif de plus-value × capital net engagé. Les frais
            de cession ne sont déduits qu&apos;au moment de la vente enregistrée.
          </p>
        </div>
      </Card>

      <Card
        title={property.saleDate ? "Cession enregistrée" : "Vendre ce bien"}
        description={
          property.saleDate
            ? "Le bien reste suivi : ses flux, ses prêts et son historique sont conservés. Corrigez la cession si nécessaire."
            : "Vendre conserve le bien et son historique ; supprimer l'efface. La vente enregistre la date, le prix et les frais, puis affiche le gain net."
        }
      >
        <div className="flex flex-col gap-4">
          {analysis.sale ? (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard
                label={`Prix de vente (${currency})`}
                value={formatOptionalMoney(analysis.sale.price, currency)}
                hint={`Vendu le ${formatDateOnly(analysis.sale.date)}`}
              />
              <StatCard
                label={`Frais de cession (${currency})`}
                value={formatOptionalMoney(analysis.sale.costs, currency)}
              />
              <StatCard
                label={`Produit net (${currency})`}
                value={formatOptionalMoney(analysis.sale.netProceeds, currency)}
                hint="Prix − frais − dette restante"
              />
              <StatCard
                label={`Gain net de la vente (${currency})`}
                value={formatOptionalMoney(analysis.sale.gain, currency)}
                tone={
                  analysis.sale.gain === null
                    ? "neutral"
                    : analysis.sale.gain.lessThan(0)
                      ? "negative"
                      : "positive"
                }
                hint="Produit net − capital net engagé"
              />
            </div>
          ) : null}

          <SaleForm
            key={property.saleDate ? "sale-edit" : "sale-new"}
            propertyId={property.id}
            propertyName={property.name}
            currency={currency}
            netInvested={decimalText(analysis.netInvested)}
            outstandingDebt={decimalText(analysis.outstandingDebt)}
            unknownLoanBalances={analysis.unknownLoanBalances}
            foreignCurrencyLoans={analysis.foreignCurrencyLoans}
            sale={saleFormValues}
          />
        </div>
      </Card>

      <Card
        id="modifier"
        title="Modifier le bien"
        description="Le prix d'acquisition et la valeur estimée nourrissent l'indicateur de cession. Une valeur vide reste « inconnue »."
      >
        <PropertyForm key={property.id} property={formValues} />
      </Card>

      <Card
        title="Historique des valorisations"
        description="Les valorisations sont append-only, datées et conservées pour audit. Une devise différente n'est jamais convertie."
      >
        <ValuationForm propertyId={property.id} currency={currency} />
        {property.valuations.length === 0 ? (
          <p className="mt-4 text-sm text-zinc-500 dark:text-zinc-400">Aucune valorisation enregistrée : valeur et équité inconnues.</p>
        ) : (
          <ul className="mt-4 space-y-2 text-sm">
            {property.valuations.map((valuation) => (
              <li key={valuation.id} className="flex flex-wrap justify-between gap-2 border-b border-zinc-200 pb-2 dark:border-zinc-800">
                <span>{formatDateOnly(valuation.valuedOn)}{valuation.sourceNote ? ` · ${valuation.sourceNote}` : ""}</span>
                <span>{formatMoney({ amount: valuation.amount, currency: valuation.currency })}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <PropertyEventsSection
        title="Échéances et obligations"
        properties={[
          {
            id: property.id,
            name: property.name,
            currency: property.priceCurrency,
          },
        ]}
        events={propertyEvents}
        today={now}
        editEvent={editingEvent ? toPropertyEventFormValues(editingEvent) : null}
        basePath={`/real-estate/${property.id}`}
      />

      <Card
        title="Historique"
        description="Acquisition, flux, financements, estimations et cession, du plus récent au plus ancien. Un flux lié à une transaction reprend son montant : rien n'est compté deux fois."
      >
        {history.length === 0 ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Aucun événement daté pour ce bien. Renseignez une date d&apos;acquisition ou
            ajoutez un flux pour commencer l&apos;historique.
          </p>
        ) : (
          <TableShell caption="Historique du bien">
            <thead>
              <tr>
                <th scope="col" className={thClass}>
                  Date
                </th>
                <th scope="col" className={thClass}>
                  Type
                </th>
                <th scope="col" className={thClass}>
                  Événement
                </th>
                <th scope="col" className={`${thClass} text-right`}>
                  Montant
                </th>
              </tr>
            </thead>
            <tbody>
              {history.map((event) => (
                <tr key={event.id}>
                  <td className={`${tdClass} whitespace-nowrap`}>{formatDateOnly(event.date)}</td>
                  <td className={tdClass}>{propertyHistoryKindLabel(event.kind)}</td>
                  <td className={tdClass}>
                    <span className="font-medium">{event.title}</span>
                    {event.detail ? (
                      <span className="block text-xs text-zinc-500 dark:text-zinc-400">
                        {event.detail}
                      </span>
                    ) : null}
                  </td>
                  <td
                    className={`${tdClass} text-right tabular-nums ${
                      event.direction === "INFLOW"
                        ? "text-emerald-700 dark:text-emerald-400"
                        : event.direction === "OUTFLOW"
                          ? "text-rose-700 dark:text-rose-400"
                          : ""
                    }`}
                  >
                    {historyAmount(event)}
                  </td>
                </tr>
              ))}
            </tbody>
          </TableShell>
        )}
      </Card>

      <Card
        title="Supprimer le bien"
        description="La suppression efface le bien, ses flux et ses prêts. Elle est définitive et ne produit aucun gain : pour conserver l'historique, enregistrez plutôt une cession."
      >
        <RemovePropertyButton property={removable} afterDelete="list" allowSell={false} />
      </Card>

      {property.notes ? (
        <Card title="Notes">
          <p className="whitespace-pre-wrap text-sm">{property.notes}</p>
        </Card>
      ) : null}
    </>
  );
}
