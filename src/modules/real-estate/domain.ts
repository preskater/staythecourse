import Decimal from "decimal.js";
import { z } from "zod";
import type { Currency } from "@/lib/money";
import {
  amount,
  currencyCode,
  optionalAmount,
  optionalDate,
  optionalId,
  optionalText,
  requiredDate,
} from "@/lib/validation";

/**
 * Real-estate module.
 *
 * A property is not assumed to be rented: `occupancy` is explicit and a vacant
 * property simply carries no rental income.
 *
 * ## Double-counting rule
 *
 * A cashflow entry describes either a linked transaction or a standalone amount,
 * never both. When a transaction is linked, **the transaction is the single
 * source of truth** and the entry stores no amount of its own; otherwise the
 * same money would be counted twice in the property totals. `resolveCashflowAmount`
 * implements that rule and both cases are covered by tests.
 */

export const PROPERTY_OCCUPANCIES = [
  "RENTED",
  "VACANT",
  "OWNER_OCCUPIED",
  "SEASONAL",
  "OTHER",
] as const;
export type PropertyOccupancy = (typeof PROPERTY_OCCUPANCIES)[number];

/** What the interface shows for each occupancy; the export reuses it verbatim. */
export const PROPERTY_OCCUPANCY_LABELS: Record<PropertyOccupancy, string> = {
  RENTED: "Loué",
  VACANT: "Vacant",
  OWNER_OCCUPIED: "Occupé par le propriétaire",
  SEASONAL: "Saisonnier",
  OTHER: "Autre",
};

export const CASHFLOW_KINDS = ["INCOME", "EXPENSE"] as const;
export type CashflowKind = (typeof CASHFLOW_KINDS)[number];

export type CashflowEntry = {
  id: string;
  kind: CashflowKind;
  label: string;
  currency: Currency;
  /** Set for a standalone entry, null when a transaction is linked. */
  amount: Decimal | null;
  dueDate: Date | null;
  settledAt: Date | null;
  transaction: {
    id: string;
    label: string;
    amount: Decimal;
  } | null;
};

/** A cashflow entry with the fields the property history displays. */
export type PropertyCashflowDetail = CashflowEntry & {
  notes: string | null;
  createdAt: Date;
};

/**
 * Margin applied above the break-even sale price when a property records none.
 * Documented in `docs/architecture/overview.md`; stored per property so the owner
 * can change it without touching the code.
 */
export const DEFAULT_TARGET_GAIN_RATE = new Decimal(10);

export type PropertySummary = {
  id: string;
  name: string;
  address: string | null;
  occupancy: PropertyOccupancy;
  purchaseDate: Date | null;
  saleDate: Date | null;
  notes: string | null;
  cashflowCount: number;
  income: Decimal;
  expenses: Decimal;
  net: Decimal;
  /** Currency of the cashflow totals above (entries carry their own). */
  currency: Currency;
  /**
   * Entries of this property that are not in `currency`: they are excluded from the
   * totals instead of being converted. A non-zero count means the totals describe one
   * currency only — never a sum of two.
   */
  foreignCurrencyCashflows: number;
  /** Reference currency of the prices below; never mixed with another one. */
  priceCurrency: Currency;
  purchasePrice: Decimal | null;
  estimatedValue: Decimal | null;
  estimatedValueAsOf: Date | null;
  targetGainRate: Decimal;
  salePrice: Decimal | null;
  saleCosts: Decimal | null;
  valuations: PropertyValuation[];
};

export type PropertyValuation = {
  id: string;
  valuedOn: Date;
  amount: Decimal;
  currency: Currency;
  sourceNote: string | null;
  createdAt: Date;
};

export class UnresolvedCashflowError extends Error {
  constructor(cashflowId: string) {
    super(
      `Cashflow ${cashflowId} has neither a linked transaction nor an amount: it cannot contribute to a total.`,
    );
    this.name = "UnresolvedCashflowError";
  }
}

/**
 * The date a cashflow is attributed to.
 *
 * A settled entry is dated by its settlement, an open one by its due date, and an
 * entry with neither by its creation, so it is never undated. The history and the
 * period indicators both read this rule: they can never place one entry in two
 * different periods.
 */
export function cashflowEntryDate(
  entry: Pick<PropertyCashflowDetail, "settledAt" | "dueDate" | "createdAt">,
): Date {
  return entry.settledAt ?? entry.dueDate ?? entry.createdAt;
}

/** Returns the amount a cashflow contributes, once and only once. */
export function resolveCashflowAmount(entry: CashflowEntry): Decimal {
  if (entry.transaction) {
    return entry.transaction.amount;
  }

  if (entry.amount) {
    return entry.amount;
  }

  throw new UnresolvedCashflowError(entry.id);
}

/**
 * The currency a property's cashflow totals are expressed in.
 *
 * The property's own reference currency wins as soon as one entry uses it: the totals
 * then cover that ledger and the caller excludes (and counts) every other entry, because
 * summing two currencies would invent a rate. Without such an entry, the first entry's
 * currency is used so an existing ledger never disappears, and a property without any
 * entry reports its reference currency rather than a default.
 */
export function selectCashflowTotalsCurrency(
  entries: readonly Pick<CashflowEntry, "currency">[],
  reference: Currency,
): Currency {
  if (entries.some((entry) => entry.currency === reference)) {
    return reference;
  }

  return entries[0]?.currency ?? reference;
}

export type PropertyTotals = {
  currency: Currency;
  income: Decimal;
  expenses: Decimal;
  net: Decimal;
};

/**
 * Totals for one property.
 *
 * `income` sums INCOME entries, `expenses` reports EXPENSE entries as a positive
 * number, and `net` is `income - expenses`. Each entry counts exactly once even
 * when it is linked to a transaction that also appears in the budget.
 */
export function computePropertyTotals(
  entries: readonly CashflowEntry[],
  options: { currency?: Currency } = {},
): PropertyTotals {
  const currency = options.currency ?? entries[0]?.currency ?? "EUR";

  let income = new Decimal(0);
  let expenses = new Decimal(0);

  for (const entry of entries) {
    if (entry.currency !== currency) {
      throw new Error(
        `Cannot total ${entry.currency} and ${currency} for one property: filter by currency first.`,
      );
    }

    const amount = resolveCashflowAmount(entry);

    if (entry.kind === "INCOME") {
      income = income.plus(amount);
    } else {
      expenses = expenses.plus(amount.abs());
    }
  }

  return { currency, income, expenses, net: income.minus(expenses) };
}

/**
 * True when a cashflow is due before `today` and has not been settled.
 * A property may legitimately have no due date: such an entry is never overdue.
 */
export function isCashflowOverdue(
  entry: Pick<CashflowEntry, "dueDate" | "settledAt">,
  today: Date,
): boolean {
  if (!entry.dueDate || entry.settledAt) {
    return false;
  }

  return entry.dueDate.getTime() < today.getTime();
}

const POSITIVE_MESSAGE = "La valeur doit être supérieure à zéro.";

/** A required positive magnitude, using the shared two-decimal amount parser. */
const positiveAmount = amount.refine(
  (value) => value.greaterThan(0),
  POSITIVE_MESSAGE,
);

/** An optional positive magnitude: empty means "not recorded", never zero. */
const optionalPositiveAmount = optionalAmount.refine(
  (value) => value === null || value.greaterThan(0),
  POSITIVE_MESSAGE,
);

/**
 * Property fields shared by the creation and the edition.
 *
 * Prices are optional on purpose: an amount that was never recorded reads
 * "inconnu" everywhere, never zero. The sale itself is not part of this contract:
 * it goes through the dedicated `propertySaleInputSchema`, so a sale always carries
 * its date and its price together.
 */
const propertyFields = z.object({
  name: z.string().trim().min(1, "Le nom est requis.").max(120),
  address: optionalText(300, "L'adresse est limitée à 300 caractères."),
  occupancy: z.enum(PROPERTY_OCCUPANCIES).default("VACANT"),
  currency: currencyCode.optional(),
  purchaseDate: optionalDate,
  purchasePrice: optionalPositiveAmount,
  estimatedValue: optionalPositiveAmount,
  estimatedValueAsOf: optionalDate,
  targetGainRate: optionalAmount
    .refine(
      (value) => value === null || (value.greaterThanOrEqualTo(0) && value.lessThanOrEqualTo(100)),
      "L'objectif doit être compris entre 0 et 100 %.",
    )
    .transform((value) => value ?? DEFAULT_TARGET_GAIN_RATE),
  notes: optionalText(2000, "Les notes sont limitées à 2000 caractères."),
});

type PropertyFields = z.infer<typeof propertyFields>;

/** A valuation is a snapshot: its amount and its observation date come together. */
function valuationIsDated(value: PropertyFields): boolean {
  return Boolean(value.estimatedValue) === Boolean(value.estimatedValueAsOf);
}

const VALUATION_MESSAGE =
  "Une valeur estimée doit être datée : renseignez le montant et sa date ensemble.";

export const propertyInputSchema = propertyFields.refine(valuationIsDated, {
  message: VALUATION_MESSAGE,
  path: ["estimatedValueAsOf"],
});

export type PropertyInput = z.input<typeof propertyInputSchema>;
export type ValidatedPropertyInput = z.output<typeof propertyInputSchema>;

/** Same rules plus the identifier, for an in-place edit. */
export const propertyUpdateSchema = propertyFields
  .extend({ id: z.string().trim().min(1, "Identifiant manquant.") })
  .refine(valuationIsDated, { message: VALUATION_MESSAGE, path: ["estimatedValueAsOf"] });

export type PropertyUpdateInput = z.input<typeof propertyUpdateSchema>;

export const propertyValuationInputSchema = z.object({
  propertyId: z.string().trim().min(1, "Bien requis."),
  valuedOn: requiredDate,
  amount: positiveAmount,
  currency: currencyCode,
  sourceNote: optionalText(500, "La note est limitée à 500 caractères."),
});

export type PropertyValuationInput = z.input<typeof propertyValuationInputSchema>;

/**
 * Input contract for a sale.
 *
 * The date and the price are required together: a sale without its price could not
 * tell what the property yielded. Selling costs are required too, with `0` allowed —
 * the form pre-fills `0`, so "no costs" is an explicit answer rather than a silent
 * default that would later look unknown.
 */
export const propertySaleInputSchema = z.object({
  id: z.string().trim().min(1, "Identifiant manquant."),
  saleDate: requiredDate,
  salePrice: positiveAmount,
  saleCosts: amount.refine(
    (value) => value.greaterThanOrEqualTo(0),
    "Les frais de cession ne peuvent pas être négatifs.",
  ),
});

export type PropertySaleInput = z.input<typeof propertySaleInputSchema>;
export type ValidatedPropertySaleInput = z.output<typeof propertySaleInputSchema>;

/**
 * Input contract for a cashflow entry.
 *
 * Exactly one of `amount` and `transactionId` is required, which is what keeps a
 * linked transaction from being counted twice (see the double-counting rule
 * above). `currency` is optional: for a linked entry the action reads it from the
 * transaction, so a property total can never mix two currencies.
 */
export const cashflowInputSchema = z
  .object({
    propertyId: z.string().trim().min(1, "Un bien est requis."),
    kind: z.enum(CASHFLOW_KINDS),
    label: z.string().trim().min(1, "Le libellé est requis.").max(200),
    /** Standalone entries only. */
    amount: optionalAmount,
    /** Links the entry to an existing transaction instead of declaring an amount. */
    transactionId: optionalId,
    currency: currencyCode.optional(),
    dueDate: optionalDate,
    settledAt: optionalDate,
    notes: optionalText(2000, "Les notes sont limitées à 2000 caractères."),
  })
  .refine((value) => Boolean(value.amount) !== Boolean(value.transactionId), {
    message:
      "Renseignez soit un montant, soit une transaction liée : jamais les deux, sinon la somme serait comptée deux fois.",
    path: ["amount"],
  });

export type CashflowInput = z.input<typeof cashflowInputSchema>;
export type ValidatedCashflowInput = z.output<typeof cashflowInputSchema>;
