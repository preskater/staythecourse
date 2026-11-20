import Decimal from "decimal.js";
import { getPrisma } from "@/lib/db";
import { toDateOnlyString } from "@/lib/dates";
import { assertCurrency } from "@/lib/money";
import type { AiProvider } from "@/modules/integrations/ai-adapter";
import type { Invoice, InvoiceInput, InvoiceLineCategory } from "./invoice";
import {
  EXCHANGE_RATE_SELECT,
  findExchangeRateSnapshotById,
  toSnapshot,
  type ExchangeRateRow,
} from "./repository";

/**
 * Provider invoice persistence (M11-06). Metadata only, always scoped to the
 * workspace; lines are reached through their invoice. There is no update: a wrong
 * invoice is deleted and typed again, so a reconciliation never silently changes.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** A rule the input schema cannot check alone (the rate belongs to the workspace). */
export class InvalidInvoiceError extends Error {
  constructor(
    readonly field: string,
    readonly userMessage: string,
  ) {
    super(`Invalid invoice ${field}`);
    this.name = "InvalidInvoiceError";
  }
}

type Sum = { currency: string; _sum: { amount: Decimal | string | null } };

function addTo(target: Map<string, Map<string, Decimal>>, key: string, row: Sum) {
  if (row._sum.amount === null) return;
  const byCurrency = target.get(key) ?? new Map<string, Decimal>();
  byCurrency.set(row.currency, (byCurrency.get(row.currency) ?? new Decimal(0)).plus(row._sum.amount.toString()));
  target.set(key, byCurrency);
}

/** Raw provider-reported sums per currency for buckets starting in `[from, to)`. */
async function reportedTotals(workspaceId: string, provider: string, from: Date, to: Date) {
  const rows = await getPrisma().aiCostLine.groupBy({
    by: ["currency"],
    where: { workspaceId, provider, periodStart: { gte: from, lt: to } },
    _sum: { amount: true },
  });
  const totals = new Map<string, Decimal>();
  for (const row of rows as Sum[]) {
    if (row._sum.amount !== null) totals.set(row.currency, new Decimal(row._sum.amount.toString()));
  }
  return totals;
}

export type ReconciliationMonth = {
  estimated: Map<string, Map<string, Decimal>>;
  reported: Map<string, Map<string, Decimal>>;
  invoices: { invoice: Invoice; reported: Map<string, Decimal> }[];
};

/**
 * Everything the reconciliation page needs for `[start, end)`: estimates and
 * provider-reported sums by provider, and each invoice starting in the month with the
 * provider sums of its own period (which may differ from the month).
 */
export async function readReconciliationMonth(
  workspaceId: string,
  start: Date,
  end: Date,
): Promise<ReconciliationMonth> {
  const prisma = getPrisma();
  const [estimatedRows, reportedRows, invoiceRows] = await Promise.all([
    prisma.costEntry.groupBy({
      by: ["sourceProvider", "currency"],
      where: { workspaceId, actuality: "ESTIMATED", sourceProvider: { not: null }, periodStart: { gte: start, lt: end } },
      _sum: { amount: true },
    }),
    prisma.aiCostLine.groupBy({
      by: ["provider", "currency"],
      where: { workspaceId, periodStart: { gte: start, lt: end } },
      _sum: { amount: true },
    }),
    prisma.providerInvoice.findMany({
      where: { workspaceId, periodStart: { gte: start, lt: end } },
      orderBy: [{ provider: "asc" }, { periodStart: "asc" }, { number: "asc" }],
      include: {
        lines: { orderBy: { position: "asc" } },
        exchangeRate: { select: EXCHANGE_RATE_SELECT },
      },
    }),
  ]);

  const estimated = new Map<string, Map<string, Decimal>>();
  for (const row of estimatedRows) addTo(estimated, row.sourceProvider!.toUpperCase(), row);
  const reported = new Map<string, Map<string, Decimal>>();
  for (const row of reportedRows) addTo(reported, row.provider, row);

  const invoices = await Promise.all(
    invoiceRows.map(async (row) => {
      const invoice: Invoice = {
        id: row.id,
        provider: row.provider as AiProvider,
        number: row.number,
        periodStart: toDateOnlyString(row.periodStart),
        periodEnd: toDateOnlyString(row.periodEnd),
        issuedOn: toDateOnlyString(row.issuedOn),
        currency: assertCurrency(row.currency),
        total: new Decimal(row.total.toString()),
        rate: row.exchangeRate ? toSnapshot(row.exchangeRate as ExchangeRateRow) : null,
        lines: row.lines.map((line) => ({
          id: line.id,
          label: line.label,
          amount: new Decimal(line.amount.toString()),
          category: line.category as InvoiceLineCategory,
        })),
      };
      // Period end is an inclusive day: the window closes at the next UTC midnight.
      const to = new Date(row.periodEnd.getTime() + DAY_MS);
      return { invoice, reported: await reportedTotals(workspaceId, row.provider, row.periodStart, to) };
    }),
  );

  return { estimated, reported, invoices };
}

/**
 * Records one invoice and its lines atomically. The rate, when given, must belong to
 * the workspace and convert another currency into the invoice's.
 */
export async function createProviderInvoice(workspaceId: string, input: InvoiceInput): Promise<{ id: string }> {
  if (input.exchangeRateSnapshotId !== null) {
    const rate = await findExchangeRateSnapshotById(workspaceId, input.exchangeRateSnapshotId);
    if (!rate) throw new InvalidInvoiceError("exchangeRateSnapshotId", "Taux introuvable dans cet espace.");
    if (rate.quoteCurrency !== input.currency) {
      throw new InvalidInvoiceError(
        "exchangeRateSnapshotId",
        `Ce taux produit des ${rate.quoteCurrency}, la facture est en ${input.currency}.`,
      );
    }
  }

  return getPrisma().providerInvoice.create({
    data: {
      workspaceId,
      provider: input.provider,
      number: input.number,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      issuedOn: input.issuedOn,
      currency: input.currency,
      total: input.total.toFixed(2),
      exchangeRateSnapshotId: input.exchangeRateSnapshotId,
      notes: input.notes,
      lines: {
        create: input.lines.map((line, position) => ({
          position,
          label: line.label,
          amount: line.amount.toFixed(2),
          category: line.category,
        })),
      },
    },
    select: { id: true },
  });
}

/** `false` when no invoice with this id exists in the workspace. Lines cascade. */
export async function deleteProviderInvoice(workspaceId: string, id: string): Promise<boolean> {
  const { count } = await getPrisma().providerInvoice.deleteMany({ where: { id, workspaceId } });
  return count > 0;
}
