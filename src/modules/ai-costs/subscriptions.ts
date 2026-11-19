import Decimal from "decimal.js";
import { z } from "zod";
import { formatDateOnly } from "@/lib/dates";
import { formatMoney, money, type Currency } from "@/lib/money";
import {
  amount,
  currencyCode,
  optionalAmount,
  optionalId,
  optionalText,
  requiredDate,
} from "@/lib/validation";
import {
  occurrenceDatesForMonth,
  RECURRENCE_FREQUENCIES,
  type RecurrenceFrequency,
} from "@/modules/budget/recurrence";
import { looksLikeSecret } from "./source";
import type { AllocationPolicyKind } from "./policy";

/**
 * AI subscription and seat register (M12-05): pure functions, no I/O, no clock.
 *
 * A subscription costs `seats × seatPrice` every period. Renewals follow the recurring
 * forecasts' calendar rules (`occurrenceDatesForMonth`): the start date's day of month,
 * clamped to shorter months, every 1, 3 or 12 months counted from the start month.
 * Each due renewal is booked once in the ledger as a DERIVED entry tagged
 * `subscription` and covering the paid period, so the core formula holds on ledger
 * figures alone:
 *
 *   AI cost = metered usage (entries without the tag) + subscriptions (tagged entries)
 *
 * Cancelling sets `cancelledOn`, the first unbilled day: renewals on or after it are
 * never booked, the ones before stay in the ledger.
 */

export const SUBSCRIPTION_TAG = "subscription";

/** How many past renewals one pass books at most, per subscription. */
export const MAX_RENEWALS_PER_PASS = 36;

export const MAX_SUBSCRIPTIONS = 200;

export type AiSubscription = {
  id: string;
  provider: string;
  plan: string;
  seats: number;
  seatPrice: Decimal;
  currency: Currency;
  frequency: RecurrenceFrequency;
  startDate: Date;
  cancelledOn: Date | null;
  allowance: Decimal | null;
  ownerId: string | null;
  allocationPolicyId: string | null;
  createdBy: string;
  notes: string | null;
};

const DAY_MS = 86_400_000;

export function periodCost(subscription: Pick<AiSubscription, "seats" | "seatPrice">): Decimal {
  return subscription.seatPrice.times(subscription.seats);
}

/** Every scheduled date in `[from, until]`, ignoring cancellation. */
function scheduledDates(
  subscription: Pick<AiSubscription, "startDate" | "frequency">,
  from: Date,
  until: Date,
): Date[] {
  const series = { startDate: subscription.startDate, endDate: null, frequency: subscription.frequency };
  const dates: Date[] = [];
  let year = from.getUTCFullYear();
  let month = from.getUTCMonth() + 1;

  while (year * 12 + month <= until.getUTCFullYear() * 12 + until.getUTCMonth() + 1) {
    for (const date of occurrenceDatesForMonth(series, year, month)) {
      if (date >= from && date <= until) dates.push(date);
    }
    month += 1;
    if (month > 12) [year, month] = [year + 1, 1];
  }

  return dates;
}

/**
 * The renewals due on or before `today`, oldest first: from the start date, before
 * the cancellation day, and at most the last `MAX_RENEWALS_PER_PASS`.
 */
export function dueRenewals(
  subscription: Pick<AiSubscription, "startDate" | "frequency" | "cancelledOn">,
  today: Date,
): Date[] {
  const until =
    subscription.cancelledOn && subscription.cancelledOn <= today
      ? new Date(subscription.cancelledOn.getTime() - DAY_MS)
      : today;
  if (until < subscription.startDate) return [];

  // Only the window the bound keeps is walked, not the whole history.
  const windowStart = new Date(
    Date.UTC(until.getUTCFullYear(), until.getUTCMonth() - MAX_RENEWALS_PER_PASS * 12, 1),
  );
  const from = windowStart > subscription.startDate ? windowStart : subscription.startDate;

  return scheduledDates(subscription, from, until).slice(-MAX_RENEWALS_PER_PASS);
}

/** The first scheduled date strictly after `after`, ignoring cancellation. */
function nextScheduled(subscription: Pick<AiSubscription, "startDate" | "frequency">, after: Date): Date {
  const from = new Date(after.getTime() + DAY_MS);
  // A yearly cadence renews within 12 months; 13 covers the day-of-month clamp.
  const until = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 13, 1));
  const start = from > subscription.startDate ? from : subscription.startDate;
  return scheduledDates(subscription, start, until)[0];
}

/** The next renewal after `today`, or `null` once cancelled before it. */
export function nextRenewal(
  subscription: Pick<AiSubscription, "startDate" | "frequency" | "cancelledOn">,
  today: Date,
): Date | null {
  const next = nextScheduled(subscription, new Date(today.getTime()));
  return subscription.cancelledOn && next >= subscription.cancelledOn ? null : next;
}

/** The days a renewal pays for: from its date to the day before the next one. */
export function renewalPeriod(
  subscription: Pick<AiSubscription, "startDate" | "frequency">,
  renewalDate: Date,
): { start: Date; end: Date } {
  const next = nextScheduled(subscription, renewalDate);
  return { start: renewalDate, end: new Date(next.getTime() - DAY_MS) };
}

/** The renewal period containing `today`, or `null` before the start or once cancelled. */
export function currentPeriod(
  subscription: Pick<AiSubscription, "startDate" | "frequency" | "cancelledOn">,
  today: Date,
): { start: Date; end: Date } | null {
  if (subscription.cancelledOn && subscription.cancelledOn <= today) return null;
  const last = dueRenewals(subscription, today).at(-1);
  return last ? renewalPeriod(subscription, last) : null;
}

export type AllowanceUsage =
  | { state: "no-allowance" }
  | { state: "no-data" }
  | { state: "within"; used: Decimal; remaining: Decimal }
  | { state: "overage"; used: Decimal; overage: Decimal };

/**
 * Metered spend of the period against the included allowance.
 *
 * `metered` is `null` when no metered entry of the provider exists in the period:
 * that is "no data", not "nothing used", and no overage is claimed.
 */
export function allowanceUsage(allowance: Decimal | null, metered: Decimal | null): AllowanceUsage {
  if (allowance === null) return { state: "no-allowance" };
  if (metered === null) return { state: "no-data" };
  return metered.greaterThan(allowance)
    ? { state: "overage", used: metered, overage: metered.minus(allowance) }
    : { state: "within", used: metered, remaining: allowance.minus(metered) };
}

/**
 * Policy kinds a subscription can be split with, and the weights each one reads.
 *
 * - `EQUAL_SEAT`: every target holds one seat, so the cost splits evenly;
 * - `FIXED_PERCENTAGE` and `REVENUE_WEIGHTED` need no measure from the caller.
 *
 * `MANUAL` and `USAGE_WEIGHTED` need figures typed for each renewal, which a
 * scheduled booking cannot supply: they are refused when the subscription is saved.
 */
export const SUBSCRIPTION_POLICY_KINDS: readonly AllocationPolicyKind[] = [
  "EQUAL_SEAT",
  "FIXED_PERCENTAGE",
  "REVENUE_WEIGHTED",
];

export function subscriptionPolicyMeasures(
  kind: AllocationPolicyKind,
  targetCount: number,
): Decimal[] | undefined {
  if (kind === "EQUAL_SEAT") return Array.from({ length: targetCount }, () => new Decimal(1));
  if (kind === "FIXED_PERCENTAGE" || kind === "REVENUE_WEIGHTED") return undefined;
  throw new Error(`Allocation policy kind ${kind} cannot split a subscription.`);
}

/* ------------------------------------------------------------------- Form contracts */

const identifier = (label: string, max: number) =>
  z
    .string()
    .trim()
    .min(1, `${label} requis.`)
    .max(max, `${max} caractères au plus.`)
    .refine((value) => !looksLikeSecret(value), "Ne saisissez jamais de clé ou de jeton ici.");

export const aiSubscriptionInputSchema = z.object({
  provider: identifier("Fournisseur", 64),
  plan: identifier("Offre", 120),
  seats: z
    .string()
    .trim()
    .transform((value, ctx) => {
      const seats = Number(value);
      if (!/^\d+$/.test(value) || seats < 1 || seats > 10_000) {
        ctx.addIssue({ code: "custom", message: "Nombre de sièges entre 1 et 10 000." });
        return z.NEVER;
      }
      return seats;
    }),
  seatPrice: amount.refine((value) => value.greaterThan(0), "Prix par siège strictement positif."),
  currency: currencyCode,
  frequency: z.enum(RECURRENCE_FREQUENCIES, { message: "Cadence inconnue." }),
  startDate: requiredDate,
  allowance: optionalAmount.refine(
    (value) => value === null || !value.isNegative(),
    "L'enveloppe incluse ne peut pas être négative.",
  ),
  ownerId: optionalText(128, "128 caractères au plus.").refine(
    (value) => value === null || !looksLikeSecret(value),
    "Ne saisissez jamais de clé ou de jeton ici.",
  ),
  allocationPolicyId: optionalId,
  notes: optionalText(500, "500 caractères au plus."),
});

export type AiSubscriptionFormValues = z.input<typeof aiSubscriptionInputSchema>;
export type AiSubscriptionInput = z.output<typeof aiSubscriptionInputSchema>;

export const cancelSubscriptionInputSchema = z.object({
  id: z.string().trim().min(1, "Identifiant manquant."),
  cancelledOn: requiredDate,
});

/* ------------------------------------------------------------------------ Page DTO */

export type SubscriptionRowDto = {
  id: string;
  label: string;
  cost: string;
  cadence: string;
  status: string;
  cancelled: boolean;
  allowance: string;
  owner: string;
  policy: string;
  renewals: string;
};

const FREQUENCY_SUFFIX: Record<RecurrenceFrequency, string> = {
  MONTHLY: "par mois",
  QUARTERLY: "par trimestre",
  YEARLY: "par an",
};

function allowanceLabel(usage: AllowanceUsage, currency: Currency): string {
  switch (usage.state) {
    case "no-allowance":
      return "—";
    case "no-data":
      return "Aucune consommation mesurée sur la période";
    case "within":
      return `${formatMoney(money(usage.used, currency))} utilisés, ${formatMoney(money(usage.remaining, currency))} restants`;
    case "overage":
      return `Dépassement de ${formatMoney(money(usage.overage, currency))}`;
  }
}

/** Strings only, ready for the page: no Decimal and no Date leave the server. */
export function toSubscriptionRows(
  subscriptions: readonly (AiSubscription & { renewalCount: number })[],
  metered: ReadonlyMap<string, Decimal | null>,
  policyNames: ReadonlyMap<string, string>,
  today: Date,
): SubscriptionRowDto[] {
  return subscriptions.map((subscription) => {
    const cancelled = subscription.cancelledOn !== null && subscription.cancelledOn <= today;
    const next = nextRenewal(subscription, today);
    const unitPrice = formatMoney(money(subscription.seatPrice, subscription.currency));

    return {
      id: subscription.id,
      label: `${subscription.provider} — ${subscription.plan}`,
      cost: `${formatMoney(money(periodCost(subscription), subscription.currency))} ${FREQUENCY_SUFFIX[subscription.frequency]}`,
      cadence: `${subscription.seats} × ${unitPrice}`,
      status: cancelled
        ? `Résilié le ${formatDateOnly(subscription.cancelledOn!)}`
        : next
          ? `Prochain renouvellement le ${formatDateOnly(next)}`
          : `Résiliation prévue le ${formatDateOnly(subscription.cancelledOn!)}`,
      cancelled,
      allowance: subscription.allowance === null
        ? "—"
        : `${formatMoney(money(subscription.allowance, subscription.currency))} inclus · ${allowanceLabel(
            allowanceUsage(subscription.allowance, metered.get(subscription.id) ?? null),
            subscription.currency,
          )}`,
      owner: subscription.ownerId ?? "—",
      policy: subscription.allocationPolicyId ? (policyNames.get(subscription.allocationPolicyId) ?? "—") : "—",
      renewals: String(subscription.renewalCount),
    };
  });
}
