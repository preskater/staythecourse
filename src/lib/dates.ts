/**
 * Date conventions (see AGENTS.md).
 *
 * - An **instant** (creation, update, synchronisation) is stored as `timestamptz`
 *   in UTC and displayed in the user's time zone.
 * - An **operation date** is a calendar day with no time and no time zone. It is
 *   stored as a PostgreSQL `DATE` and read back as a `Date` at UTC midnight.
 *
 * Monthly aggregations bucket on operation dates only, so no time-zone offset can
 * move a transaction into a neighbouring month.
 */
export const DEFAULT_TIME_ZONE = "Europe/Paris";

export class InvalidDateError extends Error {
  constructor(readonly input: string) {
    super(`Invalid date "${input}": expected the YYYY-MM-DD format.`);
    this.name = "InvalidDateError";
  }
}

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Formats an instant in the user's time zone. */
export function formatInstant(
  value: Date,
  options: { locale?: string; timeZone?: string } = {},
): string {
  return new Intl.DateTimeFormat(options.locale ?? "fr-FR", {
    timeZone: options.timeZone ?? DEFAULT_TIME_ZONE,
    dateStyle: "short",
    timeStyle: "short",
  }).format(value);
}

/** Formats a date-only value without applying any time-zone shift. */
export function formatDateOnly(
  value: Date,
  options: { locale?: string } = {},
): string {
  return new Intl.DateTimeFormat(options.locale ?? "fr-FR", {
    timeZone: "UTC",
    dateStyle: "short",
  }).format(value);
}

export function toDateOnlyString(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/**
 * Today's calendar day in the owner's time zone, as a date-only value at UTC midnight.
 *
 * An instant near midnight belongs to a different day depending on the zone: a due
 * date must be compared with the day the owner actually experiences, not with the UTC
 * day. The zone is explicit at the call site (the configured default time zone), and
 * `now` is injectable so the boundary is testable.
 */
export function todayDateOnly(
  timeZone: string = DEFAULT_TIME_ZONE,
  now: Date = new Date(),
): Date {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";

  return parseDateOnly(`${part("year")}-${part("month")}-${part("day")}`);
}

/** Parses `YYYY-MM-DD` into a date-only value at UTC midnight. */
export function parseDateOnly(value: string): Date {
  if (!DATE_ONLY_PATTERN.test(value)) {
    throw new InvalidDateError(value);
  }

  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));

  // Rejects impossible calendar days such as 2026-02-31.
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new InvalidDateError(value);
  }

  return parsed;
}

export type MonthRange = {
  year: number;
  /** 1-based month, as a human writes it. */
  month: number;
  /** Inclusive lower bound. */
  start: Date;
  /** Exclusive upper bound, so filtering uses `>= start` and `< end`. */
  end: Date;
};

/**
 * Month bounds for operation dates, computed in UTC.
 *
 * The upper bound is exclusive, which keeps boundary cases unambiguous: a
 * transaction dated the 1st of the next month is never part of this month.
 */
export function monthRange(year: number, month: number): MonthRange {
  if (!Number.isInteger(year) || year < 1970 || year > 9999) {
    throw new RangeError(`Invalid year: ${year}`);
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new RangeError(`Invalid month: ${month}`);
  }

  return {
    year,
    month,
    start: new Date(Date.UTC(year, month - 1, 1)),
    end: new Date(Date.UTC(year, month, 1)),
  };
}

/** Current month as a `YYYY-MM` key, used for defaults and CSV file names. */
export function currentMonthKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 7);
}

/**
 * A `YYYY-MM` key whose month actually exists.
 *
 * `parseMonthKey` throws on month 13, so anything read from a query string is checked
 * here first — a malformed link must fall back to a default, never crash a page.
 */
export function isValidMonthKey(value: string | null | undefined): value is string {
  return value !== null && value !== undefined && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

export function parseMonthKey(value: string): { year: number; month: number } {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (!match) {
    throw new RangeError(`Invalid month key "${value}": expected YYYY-MM.`);
  }
  return monthRange(Number(match[1]), Number(match[2]));
}

export function formatMonthLabel(year: number, month: number, locale = "fr-FR"): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: "UTC",
    month: "long",
    year: "numeric",
  }).format(new Date(Date.UTC(year, month - 1, 1)));
}

/** Short axis label, for example "oct. 25". */
export function formatShortMonthLabel(
  year: number,
  month: number,
  locale = "fr-FR",
): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: "UTC",
    month: "short",
    year: "2-digit",
  }).format(new Date(Date.UTC(year, month - 1, 1)));
}

/**
 * The `count` month keys ending with `monthKey`, oldest first.
 *
 * Month keys follow the same convention as the rest of the project: computed in
 * UTC, so a chart window never shifts by a day because of the reader's time zone.
 */
export function monthKeysEndingAt(monthKey: string, count: number): string[] {
  if (!Number.isInteger(count) || count < 1) {
    throw new RangeError(`Invalid month count: ${count}`);
  }

  const { year, month } = parseMonthKey(monthKey);
  const keys: string[] = [];

  for (let offset = count - 1; offset >= 0; offset -= 1) {
    // `monthsBack` is negative for a January window: the floor/positive modulo pair
    // rolls the year back correctly.
    const monthsBack = month - 1 - offset;
    const shiftedYear = year + Math.floor(monthsBack / 12);
    const shiftedMonth = (((monthsBack % 12) + 12) % 12) + 1;

    keys.push(`${String(shiftedYear).padStart(4, "0")}-${String(shiftedMonth).padStart(2, "0")}`);
  }

  return keys;
}

/** Shifts a `YYYY-MM` key by a number of months; negative goes back. */
export function shiftMonthKey(monthKey: string, months: number): string {
  if (!Number.isInteger(months)) {
    throw new RangeError(`Invalid month offset: ${months}`);
  }

  const { year, month } = parseMonthKey(monthKey);
  const total = year * 12 + (month - 1) + months;

  if (total < 0 || total > 9999 * 12 + 11) {
    throw new RangeError(`Month out of bounds: ${monthKey} shifted by ${months}`);
  }

  const shiftedYear = Math.floor(total / 12);
  const shiftedMonth = (total % 12) + 1;

  return `${String(shiftedYear).padStart(4, "0")}-${String(shiftedMonth).padStart(2, "0")}`;
}

/** The `count` month keys starting at `monthKey`, oldest first. */
export function monthKeysFrom(monthKey: string, count: number): string[] {
  if (!Number.isInteger(count) || count < 1) {
    throw new RangeError(`Invalid month count: ${count}`);
  }

  return Array.from({ length: count }, (_, offset) => shiftMonthKey(monthKey, offset));
}

/** Year bounds for operation dates, following the same exclusive-end convention. */
export function yearRange(year: number): { year: number; start: Date; end: Date } {
  return { year, start: monthRange(year, 1).start, end: monthRange(year, 12).end };
}
