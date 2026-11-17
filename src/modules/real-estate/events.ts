import Decimal from "decimal.js";
import { z } from "zod";
import { toDateOnlyString } from "@/lib/dates";
import type { Currency } from "@/lib/money";
import {
  currencyCode,
  optionalAmount,
  optionalDate,
  optionalText,
} from "@/lib/validation";

/**
 * Property events (RE-04).
 *
 * A property generates recurring obligations — taxes, insurance, maintenance, leases,
 * inspections, loan deadlines, renovation — that are **not** financial transactions
 * yet. They are tracked here as dated reminders, so the calendar and the alerts stay
 * honest without inventing accounting rows.
 *
 * ## Due-date state model
 *
 * `dueDate` is a calendar day (DATE, UTC midnight). The state is derived, never
 * stored, and only the status and the date decide it:
 *
 * | status    | dueDate        | state      |
 * |-----------|----------------|------------|
 * | DONE      | any            | DONE       |
 * | CANCELLED | any            | CANCELLED  |
 * | PLANNED   | null           | NO_DATE    |
 * | PLANNED   | before today   | OVERDUE    |
 * | PLANNED   | today          | DUE_TODAY  |
 * | PLANNED   | after today    | UPCOMING   |
 *
 * A DONE or CANCELLED event is never overdue, and an event without a date never
 * becomes overdue: no date is ever borrowed or fabricated.
 *
 * ## Amount rule
 *
 * `amount` is **informational only**. It is never included in `computePropertyTotals`,
 * in the KPI figures or in the budget: only a transaction (or a cashflow entry) moves
 * money, so creating an event can never create a duplicate payment.
 */

export const PROPERTY_EVENT_KINDS = [
  "TAX",
  "INSURANCE",
  "MAINTENANCE",
  "LEASE",
  "INSPECTION",
  "LOAN",
  "RENOVATION",
  "OTHER",
] as const;
export type PropertyEventKind = (typeof PROPERTY_EVENT_KINDS)[number];

export const PROPERTY_EVENT_STATUSES = ["PLANNED", "DONE", "CANCELLED"] as const;
export type PropertyEventStatus = (typeof PROPERTY_EVENT_STATUSES)[number];

export const PROPERTY_EVENT_DUE_STATES = [
  "OVERDUE",
  "DUE_TODAY",
  "UPCOMING",
  "DONE",
  "CANCELLED",
  "NO_DATE",
] as const;
export type PropertyEventDueState = (typeof PROPERTY_EVENT_DUE_STATES)[number];

export const PROPERTY_EVENT_KIND_LABELS: Record<PropertyEventKind, string> = {
  TAX: "Taxe",
  INSURANCE: "Assurance",
  MAINTENANCE: "Entretien",
  LEASE: "Bail",
  INSPECTION: "Contrôle",
  LOAN: "Échéance de prêt",
  RENOVATION: "Travaux",
  OTHER: "Autre",
};

export const PROPERTY_EVENT_STATUS_LABELS: Record<PropertyEventStatus, string> = {
  PLANNED: "À faire",
  DONE: "Terminé",
  CANCELLED: "Annulé",
};

export const PROPERTY_EVENT_DUE_STATE_LABELS: Record<PropertyEventDueState, string> = {
  OVERDUE: "En retard",
  DUE_TODAY: "Aujourd'hui",
  UPCOMING: "À venir",
  DONE: "Terminé",
  CANCELLED: "Annulé",
  NO_DATE: "Sans date",
};

export type PropertyEvent = {
  id: string;
  propertyId: string;
  propertyName: string;
  kind: PropertyEventKind;
  label: string;
  dueDate: Date | null;
  status: PropertyEventStatus;
  /** Informational only: never part of a financial total. */
  amount: Decimal | null;
  /** Currency of `amount`; null when no amount is recorded. */
  currency: Currency | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Plain string projection for the client form: never a `Decimal` or a `Date`. */
export type PropertyEventFormValues = {
  id: string;
  propertyId: string;
  kind: PropertyEventKind;
  label: string;
  dueDate: string;
  status: PropertyEventStatus;
  amount: string;
  currency: string;
  notes: string;
};

export function toPropertyEventFormValues(event: PropertyEvent): PropertyEventFormValues {
  return {
    id: event.id,
    propertyId: event.propertyId,
    kind: event.kind,
    label: event.label,
    dueDate: event.dueDate ? toDateOnlyString(event.dueDate) : "",
    status: event.status,
    amount: event.amount ? event.amount.toFixed(2) : "",
    currency: event.currency ?? "EUR",
    notes: event.notes ?? "",
  };
}

/** A calendar day at UTC midnight, so a time of day can never move the state. */
function utcDay(value: Date): number {
  return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
}

/**
 * State of an event relative to `today`.
 *
 * Both dates are compared as calendar days in UTC, which is how every operation date
 * is stored. An event due today is not late.
 */
export function propertyEventDueState(
  event: Pick<PropertyEvent, "status" | "dueDate">,
  today: Date,
): PropertyEventDueState {
  if (event.status === "DONE") {
    return "DONE";
  }

  if (event.status === "CANCELLED") {
    return "CANCELLED";
  }

  if (!event.dueDate) {
    return "NO_DATE";
  }

  const due = utcDay(event.dueDate);
  const now = utcDay(today);

  if (due < now) {
    return "OVERDUE";
  }

  return due === now ? "DUE_TODAY" : "UPCOMING";
}

export function isPropertyEventOverdue(
  event: Pick<PropertyEvent, "status" | "dueDate">,
  today: Date,
): boolean {
  return propertyEventDueState(event, today) === "OVERDUE";
}

export type PropertyEventFilter = {
  propertyId?: string | null;
  status?: PropertyEventStatus | null;
};

/**
 * Filters by property and status. An empty filter keeps every event; an unknown status
 * is the caller's responsibility to normalise before calling.
 */
export function filterPropertyEvents<T extends Pick<PropertyEvent, "propertyId" | "status">>(
  events: readonly T[],
  filter: PropertyEventFilter = {},
): T[] {
  return events.filter(
    (event) =>
      (!filter.propertyId || event.propertyId === filter.propertyId) &&
      (!filter.status || event.status === filter.status),
  );
}

export type PropertyEventSummary = {
  overdue: number;
  dueToday: number;
  upcoming: number;
  done: number;
  cancelled: number;
  withoutDate: number;
};

/**
 * Counts events by due state for the page's indicators.
 *
 * It deliberately carries **no monetary figure**: event amounts are informational and
 * must never be folded into a total.
 */
export function summarizePropertyEvents(
  events: readonly Pick<PropertyEvent, "status" | "dueDate">[],
  today: Date,
): PropertyEventSummary {
  const summary: PropertyEventSummary = {
    overdue: 0,
    dueToday: 0,
    upcoming: 0,
    done: 0,
    cancelled: 0,
    withoutDate: 0,
  };

  for (const event of events) {
    switch (propertyEventDueState(event, today)) {
      case "OVERDUE":
        summary.overdue += 1;
        break;
      case "DUE_TODAY":
        summary.dueToday += 1;
        break;
      case "UPCOMING":
        summary.upcoming += 1;
        break;
      case "DONE":
        summary.done += 1;
        break;
      case "CANCELLED":
        summary.cancelled += 1;
        break;
      case "NO_DATE":
        summary.withoutDate += 1;
        break;
    }
  }

  return summary;
}

const POSITIVE_MESSAGE = "Le montant doit être supérieur à zéro.";

/** Optional positive magnitude: empty means "not recorded", never zero. */
const optionalPositiveAmount = optionalAmount.refine(
  (value) => value === null || value.greaterThan(0),
  POSITIVE_MESSAGE,
);

/** An optional currency coming from a `<select>`: `""` means "not chosen". */
const optionalCurrencyCode = z
  .string()
  .trim()
  .nullish()
  .transform((value, ctx) => {
    if (value === null || value === undefined || value === "") {
      return null;
    }

    const parsed = currencyCode.safeParse(value);
    if (!parsed.success) {
      ctx.addIssue({ code: "custom", message: "Devise non prise en charge." });
      return z.NEVER;
    }

    return parsed.data;
  });

const eventFields = z.object({
  propertyId: z.string().trim().min(1, "Un bien est requis."),
  kind: z.enum(PROPERTY_EVENT_KINDS),
  label: z.string().trim().min(1, "Le libellé est requis.").max(200),
  dueDate: optionalDate,
  status: z.enum(PROPERTY_EVENT_STATUSES).default("PLANNED"),
  /** Informational only: never part of a financial total. */
  amount: optionalPositiveAmount,
  currency: optionalCurrencyCode,
  notes: optionalText(2000, "Les notes sont limitées à 2000 caractères."),
});

const CURRENCY_MESSAGE =
  "Renseignez la devise du montant : un montant sans devise ne peut pas être lu.";

function amountHasCurrency(value: { amount: Decimal | null; currency: Currency | null }): boolean {
  return value.amount === null || value.currency !== null;
}

/**
 * Input contract for a property event.
 *
 * The optional amount is paired with its currency: an amount without a currency reads
 * as a figure with no meaning, so the validation refuses it. A date is optional on
 * purpose — an undated obligation stays "sans date" instead of becoming overdue.
 */
export const propertyEventInputSchema = eventFields
  .refine(amountHasCurrency, { message: CURRENCY_MESSAGE, path: ["currency"] })
  .transform((value) => ({
    ...value,
    // A currency without an amount has no meaning: it is cleared, never stored alone.
    currency: value.amount === null ? null : value.currency,
  }));

export type PropertyEventInput = z.input<typeof propertyEventInputSchema>;
export type ValidatedPropertyEventInput = z.output<typeof propertyEventInputSchema>;

/** Same rules plus the identifier, for an in-place edit. */
export const propertyEventUpdateSchema = eventFields
  .extend({ id: z.string().trim().min(1, "Identifiant manquant.") })
  .refine(amountHasCurrency, { message: CURRENCY_MESSAGE, path: ["currency"] })
  .transform((value) => ({
    ...value,
    currency: value.amount === null ? null : value.currency,
  }));

export type PropertyEventUpdateInput = z.input<typeof propertyEventUpdateSchema>;
