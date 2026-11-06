import Decimal from "decimal.js";
import { getPrisma } from "@/lib/db";
import { assertCurrency, type Currency } from "@/lib/money";
import {
  computePropertyTotals,
  selectCashflowTotalsCurrency,
  type CashflowKind,
  type PropertyCashflowDetail,
  type PropertyOccupancy,
  type PropertySummary,
  type PropertyValuation,
} from "./domain";
import type { LoanSummary } from "./loans";
import type { DueCashflow } from "./alerts";
import type {
  PropertyEvent,
  PropertyEventFilter,
  PropertyEventKind,
  PropertyEventStatus,
} from "./events";
import {
  computeEquity,
  computeSaleAnalysis,
  latestPropertyValuation,
  type PropertySaleAnalysis,
} from "./valuation";

/** Real-estate persistence. Every query is scoped to the workspace. */

const PROPERTY_SELECT = {
  id: true,
  name: true,
  address: true,
  occupancy: true,
  currency: true,
  purchaseDate: true,
  purchasePrice: true,
  estimatedValue: true,
  estimatedValueAsOf: true,
  targetGainRate: true,
  saleDate: true,
  salePrice: true,
  saleCosts: true,
  notes: true,
  valuations: {
    select: {
      id: true,
      valuedOn: true,
      amount: true,
      currency: true,
      sourceNote: true,
      createdAt: true,
    },
  },
} as const;

const CASHFLOW_SELECT = {
  id: true,
  kind: true,
  label: true,
  currency: true,
  amount: true,
  dueDate: true,
  settledAt: true,
  notes: true,
  createdAt: true,
  transaction: { select: { id: true, label: true, amount: true } },
} as const;

type DecimalLike = { toString(): string };

type CashflowRow = {
  id: string;
  kind: string;
  label: string;
  currency: string;
  amount: DecimalLike | null;
  dueDate: Date | null;
  settledAt: Date | null;
  notes: string | null;
  createdAt: Date;
  transaction: { id: string; label: string; amount: DecimalLike } | null;
};

type PropertyRow = {
  id: string;
  name: string;
  address: string | null;
  occupancy: string;
  currency: string;
  purchaseDate: Date | null;
  purchasePrice: DecimalLike | null;
  estimatedValue: DecimalLike | null;
  estimatedValueAsOf: Date | null;
  targetGainRate: DecimalLike;
  saleDate: Date | null;
  salePrice: DecimalLike | null;
  saleCosts: DecimalLike | null;
  notes: string | null;
  valuations: ValuationRow[];
  cashflows: CashflowRow[];
};

type ValuationRow = {
  id: string;
  valuedOn: Date;
  amount: DecimalLike;
  currency: string;
  sourceNote: string | null;
  createdAt: Date;
};

function toOptionalDecimal(value: DecimalLike | null): Decimal | null {
  return value === null ? null : new Decimal(value.toString());
}

function toCashflowDetail(row: CashflowRow): PropertyCashflowDetail {
  return {
    id: row.id,
    kind: row.kind as CashflowKind,
    label: row.label,
    currency: assertCurrency(row.currency),
    // `null` means "linked to a transaction": see the double-counting rule.
    amount: toOptionalDecimal(row.amount),
    dueDate: row.dueDate,
    settledAt: row.settledAt,
    transaction: row.transaction
      ? {
          id: row.transaction.id,
          label: row.transaction.label,
          amount: new Decimal(row.transaction.amount.toString()),
        }
      : null,
    notes: row.notes,
    createdAt: row.createdAt,
  };
}

function toValuation(row: ValuationRow): PropertyValuation {
  return {
    id: row.id,
    valuedOn: row.valuedOn,
    amount: new Decimal(row.amount.toString()),
    currency: assertCurrency(row.currency),
    sourceNote: row.sourceNote,
    createdAt: row.createdAt,
  };
}

/**
 * Summary of one property, with its operating totals.
 *
 * `currency` is the cashflow totals currency while `priceCurrency` is the reference
 * currency of the acquisition, valuation and sale prices. They are kept distinct so a
 * caller can never silently mix both ledgers.
 *
 * Entries in the price currency are the ones totalled; an entry in another currency is
 * counted in `foreignCurrencyCashflows` and excluded, because converting it would invent
 * a rate. A property whose entries are all in another currency still reports its own
 * totals in that entry currency, so an existing ledger never disappears.
 */
function toPropertySummary(
  row: Omit<PropertyRow, "cashflows">,
  entries: PropertyCashflowDetail[],
): PropertySummary {
  const priceCurrency = assertCurrency(row.currency);
  const currency = selectCashflowTotalsCurrency(entries, priceCurrency);
  const inCurrency = entries.filter((entry) => entry.currency === currency);
  const totals = computePropertyTotals(inCurrency, { currency });

  return {
    id: row.id,
    name: row.name,
    address: row.address,
    occupancy: row.occupancy as PropertyOccupancy,
    purchaseDate: row.purchaseDate,
    saleDate: row.saleDate,
    notes: row.notes,
    cashflowCount: entries.length,
    income: totals.income,
    expenses: totals.expenses,
    net: totals.net,
    currency,
    foreignCurrencyCashflows: entries.length - inCurrency.length,
    priceCurrency,
    purchasePrice: toOptionalDecimal(row.purchasePrice),
    estimatedValue: toOptionalDecimal(row.estimatedValue),
    estimatedValueAsOf: row.estimatedValueAsOf,
    targetGainRate: new Decimal(row.targetGainRate.toString()),
    salePrice: toOptionalDecimal(row.salePrice),
    saleCosts: toOptionalDecimal(row.saleCosts),
    valuations: row.valuations.map(toValuation),
  };
}

/**
 * Every property of the workspace, by name, with its totals.
 *
 * The export may pass a `purchaseDate` window. A property without an acquisition date
 * is left out of a windowed read — it cannot be said to belong to the period, and
 * guessing would put a row in a file the owner did not ask for.
 */
export async function listProperties(
  workspaceId: string,
  options: { from?: Date; to?: Date; take?: number } = {},
): Promise<PropertySummary[]> {
  const rows = await getPrisma().property.findMany({
    where: {
      workspaceId,
      ...(options.from || options.to
        ? {
            purchaseDate: {
              ...(options.from ? { gte: options.from } : {}),
              ...(options.to ? { lt: options.to } : {}),
            },
          }
        : {}),
    },
    orderBy: { name: "asc" },
    ...(options.take ? { take: options.take } : {}),
    select: { ...PROPERTY_SELECT, cashflows: { select: CASHFLOW_SELECT } },
  });

  return rows.map((row) =>
    toPropertySummary(row, row.cashflows.map(toCashflowDetail)),
  );
}

/** One property with its full history and its sale analysis. */
export type PropertyDetail = PropertySummary & {
  cashflows: PropertyCashflowDetail[];
  loans: LoanSummary[];
  analysis: PropertySaleAnalysis;
};

/** Owner-scoped detail lookup: an identifier from a URL is never trusted. */
export async function getPropertyDetail(
  workspaceId: string,
  propertyId: string,
): Promise<PropertyDetail | null> {
  const row = await getPrisma().property.findFirst({
    where: { id: propertyId, workspaceId },
    select: {
      ...PROPERTY_SELECT,
      cashflows: {
        select: CASHFLOW_SELECT,
        orderBy: [{ dueDate: "asc" }, { createdAt: "asc" }],
      },
      loans: {
        select: LOAN_SELECT,
        orderBy: [{ startDate: "asc" }, { label: "asc" }],
      },
    },
  });

  if (!row) {
    return null;
  }

  const cashflows = row.cashflows.map(toCashflowDetail);
  const summary = toPropertySummary(row, cashflows);
  const loans = row.loans.map(toLoanSummary);
  const analysis = computeSaleAnalysis({
    currency: summary.priceCurrency,
    purchasePrice: summary.purchasePrice,
    estimatedValue: summary.estimatedValue,
    estimatedValueAsOf: summary.estimatedValueAsOf,
    targetGainRate: summary.targetGainRate,
    saleDate: summary.saleDate,
    salePrice: summary.salePrice,
    saleCosts: summary.saleCosts,
    totals: {
      income: summary.income,
      expenses: summary.expenses,
      currency: summary.currency,
    },
    totalsComplete: summary.foreignCurrencyCashflows === 0,
    loans,
  });

  const latestValuation = latestPropertyValuation(summary.valuations);
  const valuationInCurrency =
    latestValuation?.currency === summary.priceCurrency ? latestValuation : null;
  const valuationAnalysis = latestValuation
    ? computeEquity(valuationInCurrency, analysis.outstandingDebt, summary.priceCurrency)
    : null;

  return {
    ...summary,
    cashflows,
    loans,
    analysis: {
      ...analysis,
      estimatedValue: latestValuation ? valuationInCurrency?.amount ?? null : analysis.estimatedValue,
      estimatedValueAsOf: latestValuation ? latestValuation.valuedOn : analysis.estimatedValueAsOf,
      estimatedEquity: latestValuation ? valuationAnalysis : analysis.estimatedEquity,
    },
  };
}

export async function countProperties(workspaceId: string): Promise<number> {
  return getPrisma().property.count({ where: { workspaceId } });
}

/**
 * The property cashflow that links to a transaction, if any.
 *
 * Used before deleting a transaction. The schema declares that relation as
 * `onDelete: SetNull`, which would leave the cashflow with **neither** a linked
 * transaction nor an amount of its own — the one state `resolveCashflowAmount`
 * refuses, and which would break the property totals of this owner. So the deletion
 * is refused instead, and the caller can name the property to fix.
 */
export async function findCashflowLinkedToTransaction(
  workspaceId: string,
  transactionId: string,
): Promise<{ id: string; propertyName: string } | null> {
  const row = await getPrisma().propertyCashflow.findFirst({
    where: { transactionId, property: { workspaceId } },
    select: { id: true, property: { select: { name: true } } },
  });

  return row ? { id: row.id, propertyName: row.property.name } : null;
}

/** Owner-scoped property lookup: a form identifier is never trusted. */
export async function findProperty(
  workspaceId: string,
  propertyId: string,
): Promise<{ id: string; name: string } | null> {
  const row = await getPrisma().property.findFirst({
    where: { id: propertyId, workspaceId },
    select: { id: true, name: true },
  });

  return row;
}

export type PropertyWriteInput = {
  name: string;
  address: string | null;
  occupancy: PropertyOccupancy;
  currency: Currency;
  purchaseDate: Date | null;
  purchasePrice: Decimal | null;
  estimatedValue: Decimal | null;
  estimatedValueAsOf: Date | null;
  targetGainRate: Decimal;
  notes: string | null;
};

/** Amounts are stored as exact two-decimal strings, never as floats. */
function toPropertyData(input: PropertyWriteInput) {
  const price = (value: Decimal | null): string | null =>
    value === null ? null : value.toFixed(2);

  return {
    name: input.name.trim(),
    address: input.address,
    occupancy: input.occupancy,
    currency: input.currency,
    purchaseDate: input.purchaseDate,
    purchasePrice: price(input.purchasePrice),
    estimatedValue: price(input.estimatedValue),
    estimatedValueAsOf: input.estimatedValueAsOf,
    targetGainRate: input.targetGainRate.toFixed(2),
    notes: input.notes,
  };
}

export async function createProperty(
  input: PropertyWriteInput & { workspaceId: string },
): Promise<{ id: string }> {
  return getPrisma().$transaction(async (tx) => {
    const property = await tx.property.create({
      data: { workspaceId: input.workspaceId, ...toPropertyData(input) },
      select: { id: true },
    });

    if (input.estimatedValue !== null && input.estimatedValueAsOf !== null) {
      await tx.propertyValuation.create({
        data: {
          propertyId: property.id,
          valuedOn: input.estimatedValueAsOf,
          amount: input.estimatedValue.toFixed(2),
          currency: input.currency,
        },
      });
    }

    return property;
  });
}

/** Updates owner-scoped only: a property from another owner matches nothing. */
export async function updateProperty(
  workspaceId: string,
  propertyId: string,
  input: PropertyWriteInput,
): Promise<boolean> {
  return getPrisma().$transaction(async (tx) => {
    const { count } = await tx.property.updateMany({
      where: { id: propertyId, workspaceId },
      data: toPropertyData(input),
    });

    if (count === 1 && input.estimatedValue !== null && input.estimatedValueAsOf !== null) {
      await tx.propertyValuation.create({
        data: {
          propertyId,
          valuedOn: input.estimatedValueAsOf,
          amount: input.estimatedValue.toFixed(2),
          currency: input.currency,
        },
      });
    }

    return count === 1;
  });
}

/**
 * Deletes a property and, by the schema's cascades, its cashflows and loans.
 *
 * A sale is **not** a deletion: the property keeps its history and its sale figures.
 * This function is only called when the owner explicitly chooses to erase the record.
 */
export async function deleteProperty(
  workspaceId: string,
  propertyId: string,
): Promise<boolean> {
  const { count } = await getPrisma().property.deleteMany({
    where: { id: propertyId, workspaceId },
  });

  return count === 1;
}

/**
 * Records (or corrects) the sale of a property.
 *
 * Only the sale columns change: the operating history and the loans stay, which is
 * what lets the detail page show what the sale actually yielded.
 */
export async function savePropertySale(
  workspaceId: string,
  propertyId: string,
  input: { saleDate: Date; salePrice: Decimal; saleCosts: Decimal },
): Promise<boolean> {
  const { count } = await getPrisma().property.updateMany({
    where: { id: propertyId, workspaceId },
    data: {
      saleDate: input.saleDate,
      salePrice: input.salePrice.toFixed(2),
      saleCosts: input.saleCosts.toFixed(2),
    },
  });

  return count === 1;
}

export async function createPropertyValuation(
  workspaceId: string,
  input: {
    propertyId: string;
    valuedOn: Date;
    amount: Decimal;
    currency: Currency;
    sourceNote: string | null;
  },
): Promise<{ id: string } | null> {
  const property = await getPrisma().property.findFirst({
    where: { id: input.propertyId, workspaceId },
    select: { id: true },
  });
  if (!property) {
    return null;
  }

  return getPrisma().propertyValuation.create({
    data: {
      propertyId: property.id,
      valuedOn: input.valuedOn,
      amount: input.amount.toFixed(2),
      currency: input.currency,
      sourceNote: input.sourceNote,
    },
    select: { id: true },
  });
}

/**
 * Creates a cashflow entry.
 *
 * `transactionId` and `amount` are mutually exclusive, as enforced by
 * `cashflowInputSchema`; the database also rejects a second entry linked to the
 * same transaction.
 */
export async function createCashflow(input: {
  propertyId: string;
  kind: CashflowKind;
  label: string;
  amount: Decimal | null;
  transactionId: string | null;
  currency: Currency;
  dueDate: Date | null;
  settledAt: Date | null;
  notes: string | null;
}): Promise<{ id: string }> {
  return getPrisma().propertyCashflow.create({
    data: {
      propertyId: input.propertyId,
      kind: input.kind,
      label: input.label.trim(),
      amount: input.amount ? input.amount.toFixed(2) : null,
      transactionId: input.transactionId,
      currency: input.currency,
      dueDate: input.dueDate,
      settledAt: input.settledAt,
      notes: input.notes,
    },
    select: { id: true },
  });
}

/**
 * Unsettled cashflows whose due date has arrived, for the overdue alert rule.
 *
 * The owner filter goes through the property (`PropertyCashflow` carries no `workspaceId` of
 * its own), the query is bounded to due dates up to `until`, and the rule re-checks the
 * overdue condition itself — this read only narrows the rows. The amount is resolved
 * here the way totals resolve it (entry amount, else linked transaction), and stays
 * `null` when neither exists: the rule then reports "unknown", never zero.
 */
export async function listDueCashflows(
  workspaceId: string,
  options: { until?: Date } = {},
): Promise<DueCashflow[]> {
  const until = options.until ?? new Date();

  const rows = await getPrisma().propertyCashflow.findMany({
    where: {
      property: { workspaceId },
      settledAt: null,
      dueDate: { not: null, lte: until },
    },
    orderBy: { dueDate: "asc" },
    select: {
      id: true,
      kind: true,
      label: true,
      currency: true,
      amount: true,
      dueDate: true,
      settledAt: true,
      property: { select: { id: true, name: true } },
      transaction: { select: { amount: true } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    propertyId: row.property.id,
    propertyName: row.property.name,
    label: row.label,
    kind: row.kind as CashflowKind,
    currency: assertCurrency(row.currency),
    amount: row.amount
      ? new Decimal(row.amount.toString())
      : row.transaction
        ? new Decimal(row.transaction.amount.toString())
        : null,
    dueDate: row.dueDate,
    settledAt: row.settledAt,
  }));
}

/** Real-estate financing. Every query is scoped to the workspace through the property. */

const LOAN_SELECT = {
  id: true,
  propertyId: true,
  label: true,
  currency: true,
  initialPrincipal: true,
  outstandingBalance: true,
  balanceAsOf: true,
  interestRate: true,
  termMonths: true,
  paymentAmount: true,
  insuranceAmount: true,
  startDate: true,
  endDate: true,
  notes: true,
} as const;

type LoanRow = {
  id: string;
  propertyId: string;
  label: string;
  currency: string;
  initialPrincipal: DecimalLike;
  outstandingBalance: DecimalLike | null;
  balanceAsOf: Date | null;
  interestRate: DecimalLike | null;
  termMonths: number | null;
  paymentAmount: DecimalLike | null;
  insuranceAmount: DecimalLike | null;
  startDate: Date | null;
  endDate: Date | null;
  notes: string | null;
};

function toLoanSummary(row: LoanRow): LoanSummary {
  const decimal = (value: DecimalLike | null): Decimal | null =>
    value === null ? null : new Decimal(value.toString());

  return {
    id: row.id,
    propertyId: row.propertyId,
    label: row.label,
    currency: assertCurrency(row.currency),
    initialPrincipal: new Decimal(row.initialPrincipal.toString()),
    outstandingBalance: decimal(row.outstandingBalance),
    balanceAsOf: row.balanceAsOf,
    interestRate: decimal(row.interestRate),
    termMonths: row.termMonths,
    paymentAmount: decimal(row.paymentAmount),
    insuranceAmount: decimal(row.insuranceAmount),
    startDate: row.startDate,
    endDate: row.endDate,
    notes: row.notes,
  };
}

export async function listLoans(workspaceId: string): Promise<LoanSummary[]> {
  const rows = await getPrisma().propertyLoan.findMany({
    where: { property: { workspaceId } },
    orderBy: [{ propertyId: "asc" }, { label: "asc" }],
    select: LOAN_SELECT,
  });

  return rows.map(toLoanSummary);
}

/** Owner-scoped loan lookup: a form identifier is never trusted. */
export async function findLoan(
  workspaceId: string,
  loanId: string,
): Promise<LoanSummary | null> {
  const row = await getPrisma().propertyLoan.findFirst({
    where: { id: loanId, property: { workspaceId } },
    select: LOAN_SELECT,
  });

  return row ? toLoanSummary(row) : null;
}

export type LoanWriteInput = {
  propertyId: string;
  label: string;
  currency: Currency;
  initialPrincipal: Decimal;
  outstandingBalance: Decimal | null;
  balanceAsOf: Date | null;
  interestRate: Decimal | null;
  termMonths: number | null;
  paymentAmount: Decimal | null;
  insuranceAmount: Decimal | null;
  startDate: Date | null;
  endDate: Date | null;
  notes: string | null;
};

/** Persists a loan's fields. Amounts are stored as exact two-decimal strings. */
function toLoanData(input: LoanWriteInput) {
  const amount = (value: Decimal | null): string | null =>
    value === null ? null : value.toFixed(2);

  return {
    label: input.label.trim(),
    currency: input.currency,
    initialPrincipal: input.initialPrincipal.toFixed(2),
    outstandingBalance: amount(input.outstandingBalance),
    balanceAsOf: input.balanceAsOf,
    interestRate: amount(input.interestRate),
    termMonths: input.termMonths,
    paymentAmount: amount(input.paymentAmount),
    insuranceAmount: amount(input.insuranceAmount),
    startDate: input.startDate,
    endDate: input.endDate,
    notes: input.notes,
  };
}

export async function createLoan(
  input: LoanWriteInput,
): Promise<{ id: string }> {
  return getPrisma().propertyLoan.create({
    data: { propertyId: input.propertyId, ...toLoanData(input) },
    select: { id: true },
  });
}

/** Updates owner-scoped only: a loan from another owner matches nothing. */
export async function updateLoan(
  workspaceId: string,
  loanId: string,
  input: LoanWriteInput,
): Promise<boolean> {
  const { count } = await getPrisma().propertyLoan.updateMany({
    where: { id: loanId, property: { workspaceId } },
    data: { propertyId: input.propertyId, ...toLoanData(input) },
  });

  return count === 1;
}

export async function deleteLoan(workspaceId: string, loanId: string): Promise<boolean> {
  const { count } = await getPrisma().propertyLoan.deleteMany({
    where: { id: loanId, property: { workspaceId } },
  });

  return count === 1;
}

/**
 * Property events (RE-04). Every query is scoped to the workspace through the
 * property, and the optional amount is stored as an exact two-decimal string.
 */

const PROPERTY_EVENT_SELECT = {
  id: true,
  propertyId: true,
  kind: true,
  label: true,
  dueDate: true,
  status: true,
  amount: true,
  currency: true,
  notes: true,
  createdAt: true,
  updatedAt: true,
  property: { select: { name: true } },
} as const;

type PropertyEventRow = {
  id: string;
  propertyId: string;
  kind: string;
  label: string;
  dueDate: Date | null;
  status: string;
  amount: DecimalLike | null;
  currency: string | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
  property: { name: string };
};

function toPropertyEvent(row: PropertyEventRow): PropertyEvent {
  return {
    id: row.id,
    propertyId: row.propertyId,
    propertyName: row.property.name,
    kind: row.kind as PropertyEventKind,
    label: row.label,
    dueDate: row.dueDate,
    status: row.status as PropertyEventStatus,
    amount: toOptionalDecimal(row.amount),
    currency: row.currency === null ? null : assertCurrency(row.currency),
    notes: row.notes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Events of the workspace, optionally narrowed by property and status.
 *
 * Undated events are listed after dated ones: an event without a date has no place in
 * a chronological list and is never considered overdue.
 */
export async function listPropertyEvents(
  workspaceId: string,
  filter: PropertyEventFilter = {},
): Promise<PropertyEvent[]> {
  const rows = await getPrisma().propertyEvent.findMany({
    where: {
      property: { workspaceId },
      ...(filter.propertyId ? { propertyId: filter.propertyId } : {}),
      ...(filter.status ? { status: filter.status } : {}),
    },
    orderBy: [{ dueDate: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }],
    select: PROPERTY_EVENT_SELECT,
  });

  return rows.map(toPropertyEvent);
}

/** Owner-scoped event lookup: an identifier from a URL or a form is never trusted. */
export async function findPropertyEvent(
  workspaceId: string,
  eventId: string,
): Promise<PropertyEvent | null> {
  const row = await getPrisma().propertyEvent.findFirst({
    where: { id: eventId, property: { workspaceId } },
    select: PROPERTY_EVENT_SELECT,
  });

  return row ? toPropertyEvent(row) : null;
}

export type PropertyEventWriteInput = {
  propertyId: string;
  kind: PropertyEventKind;
  label: string;
  dueDate: Date | null;
  status: PropertyEventStatus;
  /** Informational only: never part of a financial total. */
  amount: Decimal | null;
  currency: Currency | null;
  notes: string | null;
};

function toPropertyEventData(input: PropertyEventWriteInput) {
  return {
    propertyId: input.propertyId,
    kind: input.kind,
    label: input.label.trim(),
    dueDate: input.dueDate,
    status: input.status,
    amount: input.amount ? input.amount.toFixed(2) : null,
    // A currency without an amount would be a figure with no meaning.
    currency: input.amount ? input.currency : null,
    notes: input.notes,
  };
}

/**
 * Creates an event for a property owned by the workspace.
 *
 * This writes **only** an event row: it never creates a transaction or a cashflow, so
 * an obligation cannot turn into a duplicate payment by accident.
 */
export async function createPropertyEvent(
  workspaceId: string,
  input: PropertyEventWriteInput,
): Promise<{ id: string } | null> {
  const property = await getPrisma().property.findFirst({
    where: { id: input.propertyId, workspaceId },
    select: { id: true },
  });
  if (!property) {
    return null;
  }

  return getPrisma().propertyEvent.create({
    data: toPropertyEventData(input),
    select: { id: true },
  });
}

/**
 * Updates an owner-scoped event. The target property is checked first when the event
 * moves, so a crafted `propertyId` can never reach another owner's property.
 */
export async function updatePropertyEvent(
  workspaceId: string,
  eventId: string,
  input: PropertyEventWriteInput,
): Promise<boolean> {
  const property = await getPrisma().property.findFirst({
    where: { id: input.propertyId, workspaceId },
    select: { id: true },
  });
  if (!property) {
    return false;
  }

  const { count } = await getPrisma().propertyEvent.updateMany({
    where: { id: eventId, property: { workspaceId } },
    data: toPropertyEventData(input),
  });

  return count === 1;
}

export async function deletePropertyEvent(
  workspaceId: string,
  eventId: string,
): Promise<boolean> {
  const { count } = await getPrisma().propertyEvent.deleteMany({
    where: { id: eventId, property: { workspaceId } },
  });

  return count === 1;
}
