import Decimal from "decimal.js";
import Link from "next/link";
import { Badge, Card, EmptyState, Notice, PageHeader, TableShell, inputClass, tdClass, thClass } from "@/components/ui";
import { ModuleDisabled } from "@/components/module-disabled";
import { requireUser } from "@/lib/auth/guard";
import { currentMonthKey, formatMonthLabel, isValidMonthKey, monthRange, parseMonthKey } from "@/lib/dates";
import { assertCurrency, formatMoney } from "@/lib/money";
import type { SearchParamsInput } from "@/lib/search-params";
import {
  INVOICE_LINE_CATEGORIES,
  INVOICE_LINE_CATEGORY_LABELS,
  INVOICE_LINE_STATUS_LABELS,
  INVOICE_STATUS_LABELS,
  PERIOD_PROVIDER_STATE_LABELS,
  reconcileInvoice,
  summarizePeriod,
  type InvoiceLineStatus,
  type InvoiceStatus,
  type PeriodProviderState,
} from "@/modules/ai-costs/invoice";
import { readReconciliationMonth, type ReconciliationMonth } from "@/modules/ai-costs/invoice.repository";
import { RECONCILIATION_TOLERANCE } from "@/modules/ai-costs/reconciliation";
import { listExchangeRates } from "@/modules/ai-costs/repository";
import { hasModule } from "@/modules/catalog/catalog";
import { canManageBusinessRecords } from "@/modules/identity/workspace";
import { DeleteInvoiceButton } from "./delete-invoice-button";
import { InvoiceForm, type InvoiceRateOption } from "./invoice-form";

export const dynamic = "force-dynamic";

type Tone = "neutral" | "positive" | "negative" | "warning";

const INVOICE_TONES: Record<InvoiceStatus, Tone> = {
  RECONCILED: "positive",
  VARIANCE: "negative",
  MISSING_USAGE: "warning",
  MISSING_RATE: "warning",
};
const LINE_TONES: Record<InvoiceLineStatus, Tone> = {
  MATCHED: "positive",
  EXPLAINED: "neutral",
  VARIANCE: "negative",
  UNMATCHED: "warning",
};
const PROVIDER_TONES: Record<PeriodProviderState, Tone> = {
  INVOICED: "positive",
  MISSING_INVOICE: "warning",
  MISSING_USAGE: "warning",
};

const money = (amount: string, currency: string) =>
  formatMoney({ amount: new Decimal(amount), currency: assertCurrency(currency) });
const list = (rows: { currency: string; amount: string }[]) =>
  rows.length === 0 ? "—" : rows.map((row) => money(row.amount, row.currency)).join(" · ");

/**
 * « Rapprochement des factures » (`/ai-costs/reconciliation`, M11-06).
 *
 * Estimate, provider-reported cost and invoice side by side for one month; every
 * invoice line is matched, classified or flagged. Read by any member; writes are
 * reserved to the owner and administrators and re-checked in the actions.
 */
export default async function ReconciliationPage({ searchParams }: { searchParams: Promise<SearchParamsInput> }) {
  const params = await searchParams;
  const user = await requireUser();

  if (!hasModule(user.workspace, "ai-costs")) {
    return <ModuleDisabled moduleKey="ai-costs" workspace={user.workspace} />;
  }

  const requested = typeof params.month === "string" ? params.month : undefined;
  const monthKey = isValidMonthKey(requested) ? requested : currentMonthKey();
  const { year, month: monthNumber } = parseMonthKey(monthKey);
  const range = monthRange(year, monthNumber);
  const workspaceId = user.workspace.id;
  const canManage = canManageBusinessRecords(user.workspace.role);

  let month: ReconciliationMonth | null = null;
  let rates: InvoiceRateOption[] = [];
  try {
    const [loaded, rateRows] = await Promise.all([
      readReconciliationMonth(workspaceId, range.start, range.end),
      canManage ? listExchangeRates(workspaceId, { take: 50 }) : Promise.resolve([]),
    ]);
    month = loaded;
    rates = rateRows.map((rate) => ({
      id: rate.id,
      label: `1 ${rate.baseCurrency} = ${rate.rate.toFixed()} ${rate.quoteCurrency} (${rate.rateDate})`,
    }));
  } catch (error) {
    // Name only: a database error message can quote amounts or identifiers.
    console.error(`[reconciliation] ${error instanceof Error ? error.name : typeof error}`);
  }

  const providers = month
    ? summarizePeriod({
        estimated: month.estimated,
        reported: month.reported,
        invoiceCounts: month.invoices.reduce(
          (counts, { invoice }) => counts.set(invoice.provider, (counts.get(invoice.provider) ?? 0) + 1),
          new Map<string, number>(),
        ),
      })
    : [];

  return (
    <>
      <PageHeader
        title="Rapprochement des factures"
        description="Estimation, coût remonté par le fournisseur et facture, côte à côte. Les écarts sont classés, jamais absorbés ; aucune valeur observée n'est remplacée par une estimation."
        actions={
          <Link href="/ai-costs" className="text-sm underline underline-offset-2">
            Coûts IA
          </Link>
        }
      />

      <form method="get" className="flex flex-wrap items-end gap-2">
        <label htmlFor="reconciliation-month" className="flex flex-col gap-1 text-sm font-medium">
          Mois
          <input id="reconciliation-month" type="month" name="month" defaultValue={monthKey} className={inputClass} />
        </label>
        <button type="submit" className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm dark:border-zinc-700">
          Afficher
        </button>
      </form>

      {!month ? (
        <Notice tone="error">
          Lecture impossible pour le moment. Ce n&apos;est pas une absence de facture : réessayez dans un instant.
        </Notice>
      ) : null}

      <Card
        title={`Fournisseurs — ${formatMonthLabel(range.year, range.month)}`}
        description="Montants dans leur devise d'origine. L'écart d'estimation n'est calculé qu'entre montants de même devise."
      >
        {month && providers.length === 0 ? (
          <EmptyState
            title="Aucune donnée ce mois-ci"
            description="Ni estimation, ni coût remonté, ni facture : rien à rapprocher. Aucun total n'est affiché pour ne pas laisser croire à un coût nul."
          />
        ) : (
          <TableShell caption="Rapprochement par fournisseur">
            <thead>
              <tr>
                <th scope="col" className={thClass}>Fournisseur</th>
                <th scope="col" className={thClass}>État</th>
                <th scope="col" className={`${thClass} text-right`}>Estimation</th>
                <th scope="col" className={`${thClass} text-right`}>Coût remonté</th>
                <th scope="col" className={`${thClass} text-right`}>Écart estimation</th>
                <th scope="col" className={`${thClass} text-right`}>Factures</th>
              </tr>
            </thead>
            <tbody>
              {providers.map((row) => (
                <tr key={row.provider}>
                  <th scope="row" className={`${tdClass} text-left font-medium`}>{row.provider}</th>
                  <td className={tdClass}>
                    <Badge tone={PROVIDER_TONES[row.state]}>{PERIOD_PROVIDER_STATE_LABELS[row.state]}</Badge>
                  </td>
                  <td className={`${tdClass} text-right tabular-nums`}>{list(row.estimated)}</td>
                  <td className={`${tdClass} text-right tabular-nums`}>{list(row.reported)}</td>
                  <td className={`${tdClass} text-right tabular-nums`}>{list(row.estimateVariance)}</td>
                  <td className={`${tdClass} text-right tabular-nums`}>{row.invoiceCount}</td>
                </tr>
              ))}
            </tbody>
          </TableShell>
        )}
      </Card>

      {month?.invoices.map(({ invoice, reported }) => {
        const result = reconcileInvoice(invoice, reported);
        const statusById = new Map(result.lines.map((line) => [line.id, line.status]));
        const summary: [string, string | null][] = [
          ["Coût remonté (devise de la facture)", result.provider],
          ...INVOICE_LINE_CATEGORIES.map(
            (category) => [`Lignes « ${INVOICE_LINE_CATEGORY_LABELS[category]} »`, result.byCategory[category]] as [string, string],
          ),
          ["Écart d'usage (usage − coût remonté)", result.usageVariance],
          ["Total des lignes", result.linesTotal],
          ["Total facturé", invoice.total.toFixed(2)],
          ["Écart total − lignes", result.linesGap],
        ];

        return (
          <Card
            key={invoice.id}
            title={`${invoice.provider} · ${invoice.number}`}
            description={`Période ${invoice.periodStart} → ${invoice.periodEnd}, émise le ${invoice.issuedOn}, en ${invoice.currency}.${
              invoice.rate
                ? ` Taux : 1 ${invoice.rate.baseCurrency} = ${invoice.rate.rate.toFixed()} ${invoice.rate.quoteCurrency} (${invoice.rate.rateDate}).`
                : ""
            }`}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Badge tone={INVOICE_TONES[result.status]}>{INVOICE_STATUS_LABELS[result.status]}</Badge>
              {canManage ? <DeleteInvoiceButton invoiceId={invoice.id} label={invoice.number} /> : null}
            </div>
            {result.status === "MISSING_USAGE" ? (
              <Notice tone="warning">
                Aucun coût remonté par {invoice.provider} sur cette période : fournisseur non connecté ou non
                synchronisé. Les lignes d&apos;usage restent non rapprochées.
              </Notice>
            ) : null}
            {result.status === "MISSING_RATE" ? (
              <Notice tone="warning">
                Coût remonté en {result.unconvertible.join(", ")} sans taux vers {invoice.currency} : l&apos;écart est
                inconnu, pas nul. Saisissez la facture à nouveau avec un taux.
              </Notice>
            ) : null}

            <TableShell caption={`Synthèse de la facture ${invoice.number}`}>
              <tbody>
                {summary.map(([label, value]) => (
                  <tr key={label}>
                    <th scope="row" className={`${tdClass} text-left font-normal`}>{label}</th>
                    <td className={`${tdClass} text-right tabular-nums`}>
                      {value === null ? <Badge tone="warning">Inconnu</Badge> : money(value, invoice.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </TableShell>

            <TableShell caption={`Lignes de la facture ${invoice.number}`}>
              <thead>
                <tr>
                  <th scope="col" className={thClass}>Libellé</th>
                  <th scope="col" className={thClass}>Catégorie</th>
                  <th scope="col" className={`${thClass} text-right`}>Montant</th>
                  <th scope="col" className={thClass}>Rapprochement</th>
                </tr>
              </thead>
              <tbody>
                {invoice.lines.map((line) => {
                  const status = statusById.get(line.id)!;
                  return (
                    <tr key={line.id}>
                      <td className={tdClass}>{line.label}</td>
                      <td className={tdClass}>{INVOICE_LINE_CATEGORY_LABELS[line.category]}</td>
                      <td className={`${tdClass} text-right tabular-nums`}>{money(line.amount.toFixed(2), invoice.currency)}</td>
                      <td className={tdClass}>
                        <Badge tone={LINE_TONES[status]}>{INVOICE_LINE_STATUS_LABELS[status]}</Badge>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </TableShell>
          </Card>
        );
      })}

      <Card
        title="Saisir une facture"
        description="Métadonnées uniquement : le document n'est jamais stocké. Pour corriger une facture, supprimez-la puis saisissez-la à nouveau."
      >
        {canManage ? (
          <InvoiceForm rates={rates} />
        ) : (
          <Notice tone="info">Lecture seule : seuls le propriétaire et les administrateurs peuvent saisir des factures.</Notice>
        )}
      </Card>

      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        Tolérance : {RECONCILIATION_TOLERANCE.toFixed(2).replace(".", ",")} sur l&apos;écart d&apos;usage, dans la devise de la facture ; le
        total et la somme des lignes doivent coïncider au centime. Le coût remonté couvre les tranches du fournisseur qui
        commencent dans la période de la facture (jours UTC), converti une seule fois puis arrondi au centime.
      </p>
    </>
  );
}
