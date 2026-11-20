import Decimal from "decimal.js";
import { z } from "zod";
import type { Currency } from "@/lib/money";
import { amount, currencyCode, optionalId, optionalText, requiredDate } from "@/lib/validation";
import { AI_PROVIDERS, type AiProvider } from "@/modules/integrations/ai-adapter";
import type { ExchangeRateSnapshot } from "./exchange";
import { roundToCents } from "./money";
import { RECONCILIATION_TOLERANCE } from "./reconciliation";

/**
 * Invoice reconciliation (M11-06).
 *
 * Three figures describe one provider period and they rarely agree: the **estimate**
 * (`CostEntry` with actuality ESTIMATED), the **provider-reported** cost (`AiCostLine`,
 * observed by the adapters) and the **invoice** (metadata typed by hand, never the
 * document). None of them overwrites another; the gap is explained, not absorbed.
 *
 * Rules, all in the invoice currency and exact to the cent:
 *
 * - `P` = provider-reported lines whose bucket **starts** inside the invoice period
 *   (UTC days, end inclusive), summed per currency at full provider precision, then
 *   converted with the invoice's rate snapshot when the currency differs, and rounded
 *   half-up to the cent **once**. A currency with no snapshot leaves `P` unknown.
 * - `USAGE` lines are compared with `P`: `usage variance = USAGE − P`. Within
 *   `RECONCILIATION_TOLERANCE` (0.01) the usage lines are matched.
 * - `CREDIT`, `DISCOUNT`, `TAX` and `FX` lines are classified adjustments: they
 *   explain the gap between `P` and the total, they map to no cost line.
 * - `OTHER` lines are unmatched by definition and always leave a visible variance.
 * - `lines gap = total − Σ lines` must be exactly zero: both sides were typed.
 *
 * The estimate is shown next to `P` for information only and never feeds a status.
 */

export const INVOICE_LINE_CATEGORIES = ["USAGE", "CREDIT", "DISCOUNT", "TAX", "FX", "OTHER"] as const;
export type InvoiceLineCategory = (typeof INVOICE_LINE_CATEGORIES)[number];

export const INVOICE_LINE_CATEGORY_LABELS: Record<InvoiceLineCategory, string> = {
  USAGE: "Usage",
  CREDIT: "Crédit",
  DISCOUNT: "Remise",
  TAX: "Taxe",
  FX: "Écart de change",
  OTHER: "Autre",
};

export const INVOICE_LINE_LIMIT = 100;

export type InvoiceStatus = "RECONCILED" | "VARIANCE" | "MISSING_USAGE" | "MISSING_RATE";

export const INVOICE_STATUS_LABELS: Record<InvoiceStatus, string> = {
  RECONCILED: "Rapprochée",
  VARIANCE: "Écart",
  MISSING_USAGE: "Usage manquant",
  MISSING_RATE: "Taux manquant",
};

export type InvoiceLineStatus = "MATCHED" | "EXPLAINED" | "VARIANCE" | "UNMATCHED";

export const INVOICE_LINE_STATUS_LABELS: Record<InvoiceLineStatus, string> = {
  MATCHED: "Rapprochée",
  EXPLAINED: "Classée",
  VARIANCE: "Écart d'usage",
  UNMATCHED: "Non rapprochée",
};

const lineSchema = z.object({
  label: z.string().trim().min(1, "Libellé requis.").max(200, "200 caractères au plus."),
  amount,
  category: z.enum(INVOICE_LINE_CATEGORIES, { message: "Catégorie invalide." }),
});

/**
 * Input of one invoice, shared by the form and the Server Action. Metadata only: no
 * file, no payment details. The rate snapshot is checked against the workspace and
 * the currencies by the repository, not here.
 */
export const invoiceInputSchema = z
  .object({
    provider: z.enum(AI_PROVIDERS, { message: "Fournisseur invalide." }),
    number: z.string().trim().min(1, "Numéro requis.").max(100, "100 caractères au plus."),
    periodStart: requiredDate,
    periodEnd: requiredDate,
    issuedOn: requiredDate,
    currency: currencyCode,
    total: amount,
    exchangeRateSnapshotId: optionalId,
    notes: optionalText(500, "500 caractères au plus."),
    lines: z
      .array(lineSchema)
      .min(1, "Au moins une ligne.")
      .max(INVOICE_LINE_LIMIT, `${INVOICE_LINE_LIMIT} lignes au plus.`),
  })
  .superRefine((value, ctx) => {
    if (value.periodEnd < value.periodStart) {
      ctx.addIssue({ code: "custom", path: ["periodEnd"], message: "La fin précède le début." });
    }
    value.lines.forEach((line, index) => {
      if (line.category === "FX" && value.exchangeRateSnapshotId === null) {
        ctx.addIssue({
          code: "custom",
          path: ["lines", index, "category"],
          message: "Un écart de change doit citer le taux utilisé : choisissez un taux.",
        });
      }
    });
  });

export type InvoiceFormValues = z.input<typeof invoiceInputSchema>;
export type InvoiceInput = z.output<typeof invoiceInputSchema>;

export type InvoiceLine = {
  id: string;
  label: string;
  amount: Decimal;
  category: InvoiceLineCategory;
};

export type Invoice = {
  id: string;
  provider: AiProvider;
  number: string;
  /** `YYYY-MM-DD`, inclusive. */
  periodStart: string;
  periodEnd: string;
  issuedOn: string;
  currency: Currency;
  total: Decimal;
  rate: ExchangeRateSnapshot | null;
  lines: InvoiceLine[];
};

export type InvoiceReconciliation = {
  status: InvoiceStatus;
  /** Currencies reported by the provider that the invoice's rate cannot convert. */
  unconvertible: string[];
  /** Exact decimal strings in the invoice currency; `null` means unknown, never zero. */
  provider: string | null;
  byCategory: Record<InvoiceLineCategory, string>;
  linesTotal: string;
  linesGap: string;
  usageVariance: string | null;
  lines: { id: string; status: InvoiceLineStatus }[];
};

const fixed = (value: Decimal) => value.toFixed(2);

/** Provider total in the invoice currency, or the currencies that block it. */
function providerInInvoiceCurrency(
  invoice: Invoice,
  provider: ReadonlyMap<string, Decimal>,
): { total: Decimal; unconvertible: string[] } {
  let total = new Decimal(0);
  const unconvertible: string[] = [];

  for (const [currency, sum] of provider) {
    if (currency === invoice.currency) {
      total = total.plus(sum);
    } else if (invoice.rate?.baseCurrency === currency && invoice.rate.quoteCurrency === invoice.currency) {
      total = total.plus(sum.times(invoice.rate.rate));
    } else {
      unconvertible.push(currency);
    }
  }

  return { total: roundToCents(total), unconvertible: unconvertible.sort() };
}

/**
 * Reconciles one invoice against the provider-reported totals of its period.
 *
 * `provider` maps a currency to the raw sum of the provider lines; an empty map means
 * the provider reported nothing for the period (not connected, or not synchronised).
 */
export function reconcileInvoice(
  invoice: Invoice,
  provider: ReadonlyMap<string, Decimal>,
): InvoiceReconciliation {
  const byCategory = Object.fromEntries(
    INVOICE_LINE_CATEGORIES.map((category) => [
      category,
      invoice.lines
        .filter((line) => line.category === category)
        .reduce((sum, line) => sum.plus(line.amount), new Decimal(0)),
    ]),
  ) as Record<InvoiceLineCategory, Decimal>;
  const linesTotal = invoice.lines.reduce((sum, line) => sum.plus(line.amount), new Decimal(0));
  const linesGap = invoice.total.minus(linesTotal);

  const missingUsage = provider.size === 0;
  const converted = missingUsage ? null : providerInInvoiceCurrency(invoice, provider);
  const known = converted !== null && converted.unconvertible.length === 0;
  const usageVariance = known ? byCategory.USAGE.minus(converted.total) : null;
  const usageMatched = usageVariance !== null && usageVariance.abs().lte(RECONCILIATION_TOLERANCE);

  const lines = invoice.lines.map((line) => {
    let status: InvoiceLineStatus;
    if (line.category === "OTHER") status = "UNMATCHED";
    else if (line.category !== "USAGE") status = "EXPLAINED";
    else if (!known) status = "UNMATCHED";
    else status = usageMatched ? "MATCHED" : "VARIANCE";
    return { id: line.id, status };
  });

  const status: InvoiceStatus = missingUsage
    ? "MISSING_USAGE"
    : !known
      ? "MISSING_RATE"
      : usageMatched && linesGap.isZero() && lines.every((line) => line.status !== "UNMATCHED")
        ? "RECONCILED"
        : "VARIANCE";

  return {
    status,
    unconvertible: converted?.unconvertible ?? [],
    provider: known ? fixed(converted.total) : null,
    byCategory: Object.fromEntries(
      INVOICE_LINE_CATEGORIES.map((category) => [category, fixed(byCategory[category])]),
    ) as Record<InvoiceLineCategory, string>,
    linesTotal: fixed(linesTotal),
    linesGap: fixed(linesGap),
    usageVariance: usageVariance === null ? null : fixed(usageVariance),
    lines,
  };
}

export type PeriodProviderState = "INVOICED" | "MISSING_INVOICE" | "MISSING_USAGE";

export const PERIOD_PROVIDER_STATE_LABELS: Record<PeriodProviderState, string> = {
  INVOICED: "Facturé",
  MISSING_INVOICE: "Facture manquante",
  MISSING_USAGE: "Usage non remonté",
};

export type PeriodProviderRow = {
  provider: string;
  state: PeriodProviderState;
  /** Per currency, exact strings; empty means no figure of that kind. */
  estimated: { currency: string; amount: string }[];
  reported: { currency: string; amount: string }[];
  /** `estimated − reported`, only where both exist in the same currency. */
  estimateVariance: { currency: string; amount: string }[];
  invoiceCount: number;
};

type Totals = ReadonlyMap<string, ReadonlyMap<string, Decimal>>;

/**
 * One row per provider seen in the month, from any of the three sources.
 *
 * A provider with reported usage and no invoice is "facture manquante"; one with an
 * invoice or an estimate and no reported usage is "usage non remonté". Amounts stay
 * in their own currency: the estimate is never converted nor compared across currencies.
 */
export function summarizePeriod(input: {
  estimated: Totals;
  reported: Totals;
  invoiceCounts: ReadonlyMap<string, number>;
}): PeriodProviderRow[] {
  const providers = [
    ...new Set([...input.estimated.keys(), ...input.reported.keys(), ...input.invoiceCounts.keys()]),
  ].sort();
  const list = (totals: ReadonlyMap<string, Decimal> | undefined) =>
    [...(totals ?? new Map<string, Decimal>())]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([currency, value]) => ({ currency, amount: fixed(roundToCents(value)) }));

  return providers.map((provider) => {
    const estimated = input.estimated.get(provider);
    const reported = input.reported.get(provider);
    const invoiceCount = input.invoiceCounts.get(provider) ?? 0;
    const hasUsage = (reported?.size ?? 0) > 0;

    return {
      provider,
      state: !hasUsage ? "MISSING_USAGE" : invoiceCount === 0 ? "MISSING_INVOICE" : "INVOICED",
      estimated: list(estimated),
      reported: list(reported),
      estimateVariance: [...(estimated ?? [])]
        .filter(([currency]) => reported?.has(currency))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([currency, value]) => ({
          currency,
          amount: fixed(roundToCents(value.minus(reported!.get(currency)!))),
        })),
      invoiceCount,
    };
  });
}
