import Decimal from "decimal.js";
import { toDateOnlyString } from "@/lib/dates";
import type { BillingCycle } from "./overview";
import { dueRenewals, periodCost, type AiSubscription } from "./subscriptions";

/**
 * Billing-cycle forecast (M12-04): pure functions, no I/O, no clock.
 *
 * Forecast to the end of the cycle, per currency, never converted, always ESTIMATED:
 *
 *   forecast = metered to date + daily rate × remaining days
 *            + subscriptions booked this cycle + renewals still to come this cycle
 *
 * - Metered usage: ledger entries without the `subscription` tag, by the day their
 *   period starts. The daily rate is their sum over the last `WINDOW_DAYS` days (today
 *   included, possibly reaching into the previous cycle) divided by `WINDOW_DAYS`.
 * - Fewer than `MIN_DAYS_WITH_DATA` days with metered spend in that window is
 *   "insufficient data": no figure is shown rather than a confident-looking guess.
 *   On the cycle's last day nothing remains to project, so the known spend stands.
 * - Subscriptions: renewals already booked (tagged entries of the cycle) plus the ones
 *   the register schedules after today and before the cycle ends (seats × seat price).
 *
 * Cycle boundaries: metered usage follows the dashboard's calendar month whatever the
 * provider (the ledger has no per-provider invoice cycle); a subscription renews on its
 * own day, and a renewal on the cycle's last day belongs to this cycle.
 */

export const WINDOW_DAYS = 14;
export const MIN_DAYS_WITH_DATA = 5;

const DAY_MS = 86_400_000;

export type MeteredDay = { day: Date; currency: string; amount: Decimal };

export type ForecastInputs = {
  /** Metered spend per currency, from the cycle start to today included. */
  meteredToDate: ReadonlyMap<string, Decimal>;
  /** Metered spend per day and currency over the window. */
  meteredDays: readonly MeteredDay[];
  /** Subscription renewals already booked this cycle, per currency. */
  subscriptionsBooked: ReadonlyMap<string, Decimal>;
  subscriptions: readonly AiSubscription[];
};

export type UpcomingRenewal = { label: string; date: string; amount: Decimal };

export type CurrencyForecast = {
  currency: string;
  meteredToDate: Decimal;
  daysWithData: number;
  /** `null` when the data is insufficient. */
  dailyRate: Decimal | null;
  remainingDays: number;
  meteredForecast: Decimal | null;
  subscriptionsBooked: Decimal;
  upcoming: UpcomingRenewal[];
  /** `null` when the data is insufficient. */
  total: Decimal | null;
};

export function windowStart(today: Date): Date {
  return new Date(today.getTime() - (WINDOW_DAYS - 1) * DAY_MS);
}

/** Days left after today in the cycle (0 on its last day). */
export function remainingDays(cycle: BillingCycle): number {
  return Math.round((cycle.end.getTime() - cycle.today.getTime()) / DAY_MS) - 1;
}

/** Renewals scheduled after today and before the cycle ends, cancellations respected. */
export function upcomingRenewals(subscriptions: readonly AiSubscription[], cycle: BillingCycle): (UpcomingRenewal & { currency: string })[] {
  const lastDay = new Date(cycle.end.getTime() - DAY_MS);

  return subscriptions.flatMap((subscription) =>
    dueRenewals(subscription, lastDay)
      .filter((date) => date > cycle.today)
      .map((date) => ({
        label: `${subscription.provider} — ${subscription.plan}`,
        date: toDateOnlyString(date),
        amount: periodCost(subscription),
        currency: subscription.currency,
      })),
  );
}

export function forecastCycle(inputs: ForecastInputs, cycle: BillingCycle): CurrencyForecast[] {
  const remaining = remainingDays(cycle);
  const from = windowStart(cycle.today);
  const upcoming = upcomingRenewals(inputs.subscriptions, cycle);
  const days = inputs.meteredDays.filter((row) => row.day >= from && row.day <= cycle.today);

  const currencies = new Set([
    ...inputs.meteredToDate.keys(),
    ...days.map((row) => row.currency),
    ...inputs.subscriptionsBooked.keys(),
    ...upcoming.map((row) => row.currency),
  ]);

  return [...currencies].sort().map((currency) => {
    const ofCurrency = days.filter((row) => row.currency === currency);
    const daysWithData = new Set(
      ofCurrency.filter((row) => !row.amount.isZero()).map((row) => toDateOnlyString(row.day)),
    ).size;
    const toDate = inputs.meteredToDate.get(currency) ?? new Decimal(0);
    const booked = inputs.subscriptionsBooked.get(currency) ?? new Decimal(0);
    const renewals = upcoming.filter((row) => row.currency === currency).map(({ label, date, amount }) => ({ label, date, amount }));
    const upcomingTotal = renewals.reduce((sum, row) => sum.plus(row.amount), new Decimal(0));

    const sufficient = remaining === 0 || daysWithData >= MIN_DAYS_WITH_DATA;
    const dailyRate = sufficient
      ? ofCurrency.reduce((sum, row) => sum.plus(row.amount), new Decimal(0)).dividedBy(WINDOW_DAYS)
      : null;
    const meteredForecast = dailyRate === null ? null : toDate.plus(dailyRate.times(remaining));

    return {
      currency,
      meteredToDate: toDate,
      daysWithData,
      dailyRate,
      remainingDays: remaining,
      meteredForecast,
      subscriptionsBooked: booked,
      upcoming: renewals,
      total: meteredForecast === null ? null : meteredForecast.plus(booked).plus(upcomingTotal),
    };
  });
}
