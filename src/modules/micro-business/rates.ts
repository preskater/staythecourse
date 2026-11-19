import Decimal from "decimal.js";
import { z } from "zod";
import { formatMonthLabel, isValidMonthKey } from "@/lib/dates";
import type { Currency } from "@/lib/money";
import { amount, currencyCode } from "@/lib/validation";
import { hasPermission } from "@/modules/identity/permissions";
import type { WorkspaceRole } from "@/modules/identity/workspace";

/**
 * Rate cards and loaded labour costs (M10-03).
 *
 * Two distinct concepts, stored separately and never merged:
 *
 * - a **billing rate** is what a client pays per hour, effective from a month;
 * - an **internal cost rate** is the confidential loaded cost of an hour, effective
 *   from a month.
 *
 * Both are change points, like the salary rate of the budget module: resolving a month
 * means reading the most recent entry at or before it. Before the first entry there is
 * no rate at all — the answer is `null`, never a guessed default.
 *
 * Rates are history. Correcting a change point is an upsert on the same month; there is
 * no delete, so a period never silently loses its rate. No document stores an amount
 * derived from a rate, so changing one never rewrites an amount computed elsewhere.
 *
 * Internal rates are confidential: `canReadInternalRates` is the single check, and the
 * page and actions never query them without it.
 */

/** The part of a rate row the resolver needs. */
export type RateChangePoint = {
  year: number;
  /** 1-based month, as a human writes it. */
  month: number;
  hourlyRate: Decimal;
};

export type BillingRateRecord = RateChangePoint & {
  id: string;
  clientId: string;
  clientName: string;
  currency: Currency;
};

export type InternalCostRateRecord = RateChangePoint & {
  id: string;
  currency: Currency;
};

/**
 * The rate in force for a month, or `null` when no entry covers it.
 *
 * The most recent change point at or before the month wins. A month before the first
 * entry has no rate: the caller shows "not defined" instead of inventing one. The
 * function is pure and order-independent for distinct months; the database's unique
 * constraint prevents two change points for the same client or workspace and month.
 */
export function resolveEffectiveRate<T extends RateChangePoint>(
  rates: readonly T[],
  year: number,
  month: number,
): T | null {
  let resolved: T | null = null;

  for (const rate of rates) {
    const isAtOrBefore = rate.year < year || (rate.year === year && rate.month <= month);
    if (!isAtOrBefore) {
      continue;
    }

    const isLatest =
      resolved === null ||
      rate.year > resolved.year ||
      (rate.year === resolved.year && rate.month > resolved.month);
    if (isLatest) {
      resolved = rate;
    }
  }

  return resolved;
}

/**
 * Whether the role may see the confidential internal cost rates.
 *
 * One check for the page, the actions and the DTO path: without it, the rows are never
 * queried, so no field can leak through a component or a log.
 */
export function canReadInternalRates(role: WorkspaceRole): boolean {
  return hasPermission(role, "read-internal-rates");
}

const MONTH_MESSAGE = "Mois attendu au format AAAA-MM.";
const RATE_MESSAGE = "Le taux horaire doit être supérieur à zéro.";

/** A `YYYY-MM` field, read from `<input type="month">` or a link. */
const rateMonth = z
  .string()
  .trim()
  .refine(isValidMonthKey, MONTH_MESSAGE);

const hourlyRate = amount.refine(
  (value) => value.greaterThan(0),
  RATE_MESSAGE,
);

export const billingRateInputSchema = z.object({
  clientId: z.string().trim().min(1, "Un client est requis."),
  month: rateMonth,
  hourlyRate,
  currency: currencyCode,
});

export type BillingRateInput = z.input<typeof billingRateInputSchema>;
export type ValidatedBillingRateInput = z.output<typeof billingRateInputSchema>;

export const internalCostRateInputSchema = z.object({
  month: rateMonth,
  hourlyRate,
  currency: currencyCode,
});

export type InternalCostRateInput = z.input<typeof internalCostRateInputSchema>;
export type ValidatedInternalCostRateInput = z.output<typeof internalCostRateInputSchema>;

/** The month a rate applies from, in the interface's French wording. */
export function ratePeriodLabel(year: number, month: number): string {
  return formatMonthLabel(year, month);
}
