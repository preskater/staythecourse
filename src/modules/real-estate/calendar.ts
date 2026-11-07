import { monthRange, toDateOnlyString } from "@/lib/dates";
import type { CashflowKind } from "./domain";
import {
  PROPERTY_EVENT_KIND_LABELS,
  propertyEventDueState,
  type PropertyEvent,
  type PropertyEventDueState,
} from "./events";

/**
 * Property calendar.
 *
 * The calendar reads two sources that describe the same months from different angles:
 * a property event (RE-04) and a cashflow due date. They are merged into one list of
 * calendar entries so the owner sees a single month instead of two partial tables.
 *
 * ## Date rule
 *
 * A `dueDate` is a calendar day (`DATE`, read at UTC midnight). Grouping therefore uses
 * the UTC day, never the reader's time zone: an entry can never move to the previous or
 * next day — or month — because of an offset. Only the month and day headings are
 * formatted for display.
 *
 * An entry without a date stays undated: it is never placed in a month and never
 * borrows the month being displayed. It appears in the list view only.
 *
 * ## Status rule
 *
 * Events keep their stored status; a cashflow is done once it is settled, open until
 * then. Both collapse to the three calendar statuses the filter offers:
 *
 * | source   | state                                  | calendar status |
 * |----------|----------------------------------------|-----------------|
 * | event    | `PLANNED`                              | `OPEN`          |
 * | event    | `DONE`                                 | `DONE`          |
 * | event    | `CANCELLED`                            | `CANCELLED`     |
 * | cashflow | unsettled                              | `OPEN`          |
 * | cashflow | settled                                | `DONE`          |
 *
 * The due state (overdue, due today, upcoming, done, cancelled, no date) is derived
 * from that status and the date, exactly as it is for an event.
 */

export const CALENDAR_SOURCES = ["EVENT", "CASHFLOW"] as const;
export type CalendarSource = (typeof CALENDAR_SOURCES)[number];

export const CALENDAR_STATUSES = ["OPEN", "DONE", "CANCELLED"] as const;
export type CalendarStatus = (typeof CALENDAR_STATUSES)[number];

export const CALENDAR_STATUS_LABELS: Record<CalendarStatus, string> = {
  OPEN: "À faire",
  DONE: "Terminé",
  CANCELLED: "Annulé",
};

export const CALENDAR_SOURCE_LABELS: Record<CalendarSource, string> = {
  EVENT: "Échéance",
  CASHFLOW: "Flux",
};

const CASHFLOW_KIND_LABELS: Record<CashflowKind, string> = {
  INCOME: "Recette",
  EXPENSE: "Charge",
};

/**
 * A cashflow as the calendar reads it.
 *
 * Only the fields needed to place and label the entry cross the boundary: the amount
 * and notes stay on the property page, where they are read in context.
 */
export type CalendarCashflow = {
  id: string;
  propertyId: string;
  propertyName: string;
  kind: CashflowKind;
  label: string;
  dueDate: Date | null;
  settledAt: Date | null;
};

/** One entry of the calendar, whether it comes from an event or a cashflow. */
export type CalendarEntry = {
  /** Namespaced id, so an event and a cashflow with the same id never collide. */
  id: string;
  sourceId: string;
  source: CalendarSource;
  propertyId: string;
  propertyName: string;
  label: string;
  /** Calendar day; `null` when the source records none. */
  dueDate: Date | null;
  dueState: PropertyEventDueState;
  status: CalendarStatus;
  /** Human label of the source nature ("Taxe", "Recette", ...). */
  kindLabel: string;
};

/** Collapses a derived due state to the status the calendar filters on. */
export function calendarStatusFromDueState(state: PropertyEventDueState): CalendarStatus {
  if (state === "DONE") {
    return "DONE";
  }

  if (state === "CANCELLED") {
    return "CANCELLED";
  }

  return "OPEN";
}

/**
 * Due state of a cashflow: settled entries are done, unsettled ones follow the same
 * calendar-day comparison as an event. An entry without a due date stays `NO_DATE`.
 */
export function cashflowDueState(
  cashflow: Pick<CalendarCashflow, "dueDate" | "settledAt">,
  today: Date,
): PropertyEventDueState {
  return propertyEventDueState(
    { status: cashflow.settledAt ? "DONE" : "PLANNED", dueDate: cashflow.dueDate },
    today,
  );
}

export function toCalendarEntryFromEvent(event: PropertyEvent, today: Date): CalendarEntry {
  const dueState = propertyEventDueState(event, today);

  return {
    id: `event:${event.id}`,
    sourceId: event.id,
    source: "EVENT",
    propertyId: event.propertyId,
    propertyName: event.propertyName,
    label: event.label,
    dueDate: event.dueDate,
    dueState,
    status: calendarStatusFromDueState(dueState),
    kindLabel: PROPERTY_EVENT_KIND_LABELS[event.kind],
  };
}

export function toCalendarEntryFromCashflow(
  cashflow: CalendarCashflow,
  today: Date,
): CalendarEntry {
  const dueState = cashflowDueState(cashflow, today);

  return {
    id: `cashflow:${cashflow.id}`,
    sourceId: cashflow.id,
    source: "CASHFLOW",
    propertyId: cashflow.propertyId,
    propertyName: cashflow.propertyName,
    label: cashflow.label,
    dueDate: cashflow.dueDate,
    dueState,
    status: calendarStatusFromDueState(dueState),
    kindLabel: CASHFLOW_KIND_LABELS[cashflow.kind],
  };
}

/** Merges both sources; the order is not significant, each view sorts what it shows. */
export function buildCalendarEntries({
  events,
  cashflows,
  today,
}: {
  events: readonly PropertyEvent[];
  cashflows: readonly CalendarCashflow[];
  today: Date;
}): CalendarEntry[] {
  return [
    ...events.map((event) => toCalendarEntryFromEvent(event, today)),
    ...cashflows.map((cashflow) => toCalendarEntryFromCashflow(cashflow, today)),
  ];
}

export type CalendarFilter = {
  propertyId?: string | null;
  status?: CalendarStatus | null;
};

/** Filters by property and status; an empty filter keeps every entry. */
export function filterCalendarEntries(
  entries: readonly CalendarEntry[],
  filter: CalendarFilter = {},
): CalendarEntry[] {
  return entries.filter(
    (entry) =>
      (!filter.propertyId || entry.propertyId === filter.propertyId) &&
      (!filter.status || entry.status === filter.status),
  );
}

function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

/**
 * Chronological order: dated entries first, undated entries last.
 *
 * The list view uses this order so an undated entry is never pushed between two
 * months it does not belong to; the month view keeps only the dated ones.
 */
export function sortCalendarEntries(entries: readonly CalendarEntry[]): CalendarEntry[] {
  return [...entries].sort((left, right) => {
    if (left.dueDate && right.dueDate) {
      const byDate = left.dueDate.getTime() - right.dueDate.getTime();
      if (byDate !== 0) {
        return byDate;
      }
    } else if (left.dueDate) {
      return -1;
    } else if (right.dueDate) {
      return 1;
    }

    return (
      compareText(left.propertyName, right.propertyName) ||
      compareText(left.label, right.label) ||
      compareText(left.id, right.id)
    );
  });
}

export type CalendarMonthCell = {
  /** `YYYY-MM-DD`, or `null` for a padding cell outside the month. */
  date: string | null;
  /** Day of the month, or `null` for a padding cell. */
  day: number | null;
  entries: CalendarEntry[];
  isToday: boolean;
};

export type CalendarMonth = {
  year: number;
  /** 1-based month, as a human writes it. */
  month: number;
  /** `YYYY-MM`. */
  monthKey: string;
  /** Monday-first grid, padded to complete weeks. */
  cells: CalendarMonthCell[];
  /** Dated entries inside the month, chronological. */
  entries: CalendarEntry[];
  /** Undated entries are list-only; this counts them without placing them. */
  undatedCount: number;
};

function toMonthKey(year: number, month: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
}

/**
 * Builds the month grid and places each dated entry in its UTC calendar day.
 *
 * Boundaries follow `monthRange`: the first day is included and the first day of the
 * next month is never part of the grid. A padding cell carries no date, so an adjacent
 * month can never appear as if it belonged to this one. Entries without a date are
 * counted but left out of every cell.
 */
export function buildCalendarMonth(
  entries: readonly CalendarEntry[],
  options: { year: number; month: number; todayKey?: string | null },
): CalendarMonth {
  const { year, month, todayKey = null } = options;
  const { start, end } = monthRange(year, month);
  const daysInMonth = Math.round((end.getTime() - start.getTime()) / 86_400_000);
  // `getUTCDay()` is 0 for Sunday; the grid starts on Monday.
  const leadingBlanks = (start.getUTCDay() + 6) % 7;

  const entriesByDate = new Map<string, CalendarEntry[]>();
  for (const entry of entries) {
    if (!entry.dueDate) {
      continue;
    }

    const key = toDateOnlyString(entry.dueDate);
    const bucket = entriesByDate.get(key);

    if (bucket) {
      bucket.push(entry);
    } else {
      entriesByDate.set(key, [entry]);
    }
  }

  const cells: CalendarMonthCell[] = Array.from({ length: leadingBlanks }, () => ({
    date: null,
    day: null,
    entries: [],
    isToday: false,
  }));

  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = toDateOnlyString(new Date(Date.UTC(year, month - 1, day)));

    cells.push({
      date,
      day,
      entries: entriesByDate.get(date) ?? [],
      isToday: date === todayKey,
    });
  }

  while (cells.length % 7 !== 0) {
    cells.push({ date: null, day: null, entries: [], isToday: false });
  }

  return {
    year,
    month,
    monthKey: toMonthKey(year, month),
    cells,
    entries: sortCalendarEntries(cells.flatMap((cell) => cell.entries)),
    undatedCount: entries.filter((entry) => entry.dueDate === null).length,
  };
}
