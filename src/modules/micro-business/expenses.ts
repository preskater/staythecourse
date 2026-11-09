import Decimal from "decimal.js";
import { z } from "zod";
import type { Currency } from "@/lib/money";
import { amount, currencyCode, optionalDate, optionalText, requiredDate } from "@/lib/validation";
import {
  occurrenceDatesForMonth,
  RECURRENCE_FREQUENCIES,
  type RecurrenceFrequency,
} from "@/modules/budget/recurrence";

/**
 * Recurring business expenses and obligations (M10-05).
 *
 * A definition describes a series — label, payee, positive amount, currency, cadence,
 * start and optional end date, and a kind. It writes **nothing** to the budget ledger:
 * the upcoming due dates are computed on read, so re-running the computation can never
 * create a duplicate occurrence. This is the deliberate difference from the budget's
 * forecast, which materialises occurrences because each one can be confirmed.
 *
 * The day-of-month and cadence rules are the budget module's, reused unchanged: a
 * renewal falls on the start date's day, clamped to the month's length (the 31st →
 * 28/29 February, 30 April), the cadence counts from the start month, and the end date
 * is inclusive.
 *
 * Every amount is a planning estimate. `RESERVE` is an explicit planning envelope (for
 * example social charges); nothing here is a payment, an accounting entry or tax advice.
 */

export const BUSINESS_EXPENSE_KINDS = ["EXPENSE", "OBLIGATION", "RESERVE"] as const;
export type BusinessExpenseKind = (typeof BUSINESS_EXPENSE_KINDS)[number];

export const BUSINESS_EXPENSE_KIND_LABELS: Record<BusinessExpenseKind, string> = {
  EXPENSE: "Charge récurrente",
  OBLIGATION: "Obligation",
  RESERVE: "Enveloppe de réserve",
};

export type BusinessExpenseRecord = {
  id: string;
  label: string;
  vendor: string | null;
  kind: BusinessExpenseKind;
  /** Positive magnitude, in `currency`. */
  amount: Decimal;
  currency: Currency;
  frequency: RecurrenceFrequency;
  /** First day of the series, a calendar day at UTC midnight. */
  startDate: Date;
  /** Last day of the series, inclusive; `null` means no end. */
  endDate: Date | null;
  notes: string | null;
};

/** One computed renewal. */
export type UpcomingBusinessExpense = {
  expense: BusinessExpenseRecord;
  /** Calendar day at UTC midnight. */
  date: Date;
};

/** The start of the calendar day, ignoring any time a caller may have left on it. */
function dayStart(value: Date): number {
  return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
}

/**
 * The renewals that fall between `fromDate` and the end of the `months`-month window,
 * in date order.
 *
 * The window starts with the month of `fromDate` (so a renewal due today is included)
 * and covers `months` calendar months. Occurrences strictly before `fromDate` are
 * dropped: the list is "what is still to come", not the history. Each definition
 * contributes at most one date per month, so calling this twice yields the same list —
 * there is no materialised row to duplicate.
 */
export function upcomingBusinessExpenses(
  expenses: readonly BusinessExpenseRecord[],
  fromDate: Date,
  months: number,
): UpcomingBusinessExpense[] {
  if (!Number.isInteger(months) || months < 1) {
    throw new RangeError(`Invalid month window: ${months}`);
  }

  const fromDay = dayStart(fromDate);
  const startYear = fromDate.getUTCFullYear();
  const startMonth = fromDate.getUTCMonth() + 1;
  const upcoming: UpcomingBusinessExpense[] = [];

  for (let offset = 0; offset < months; offset += 1) {
    const monthIndex = startYear * 12 + (startMonth - 1) + offset;
    const year = Math.floor(monthIndex / 12);
    const month = (monthIndex % 12) + 1;

    for (const expense of expenses) {
      for (const date of occurrenceDatesForMonth(expense, year, month)) {
        if (dayStart(date) >= fromDay) {
          upcoming.push({ expense, date });
        }
      }
    }
  }

  return upcoming.sort(
    (left, right) =>
      left.date.getTime() - right.date.getTime() ||
      left.expense.label.localeCompare(right.expense.label) ||
      left.expense.id.localeCompare(right.expense.id),
  );
}

export type UpcomingExpenseTotal = {
  currency: Currency;
  total: Decimal;
  count: number;
};

/** The upcoming window's planned total per currency; currencies are never converted. */
export function upcomingExpenseTotals(
  upcoming: readonly UpcomingBusinessExpense[],
): UpcomingExpenseTotal[] {
  const totals = new Map<Currency, UpcomingExpenseTotal>();

  for (const { expense } of upcoming) {
    const total = totals.get(expense.currency) ?? {
      currency: expense.currency,
      total: new Decimal(0),
      count: 0,
    };

    total.total = total.total.plus(expense.amount);
    total.count += 1;
    totals.set(expense.currency, total);
  }

  return [...totals.values()].sort((left, right) =>
    left.currency.localeCompare(right.currency),
  );
}

const AMOUNT_MESSAGE = "Le montant prévu doit être supérieur à zéro.";
const END_DATE_MESSAGE = "La date de fin ne peut pas précéder la date de début.";

const businessExpenseFields = z.object({
  label: z.string().trim().min(1, "Le libellé est requis.").max(200, "Le libellé est limité à 200 caractères."),
  vendor: optionalText(160, "Le fournisseur est limité à 160 caractères."),
  kind: z.enum(BUSINESS_EXPENSE_KINDS, "Type de charge inconnu."),
  amount: amount.refine((value) => value.greaterThan(0), AMOUNT_MESSAGE),
  currency: currencyCode,
  frequency: z.enum(RECURRENCE_FREQUENCIES, "Cadence inconnue."),
  startDate: requiredDate,
  endDate: optionalDate,
  notes: optionalText(2000, "Les notes sont limitées à 2000 caractères."),
});

type BusinessExpenseFields = z.infer<typeof businessExpenseFields>;

function endDateAfterStart(value: BusinessExpenseFields): boolean {
  return value.endDate === null || value.endDate.getTime() >= value.startDate.getTime();
}

export const businessExpenseInputSchema = businessExpenseFields.refine(
  endDateAfterStart,
  { message: END_DATE_MESSAGE, path: ["endDate"] },
);

export type BusinessExpenseInput = z.input<typeof businessExpenseInputSchema>;
export type ValidatedBusinessExpenseInput = z.output<typeof businessExpenseInputSchema>;
