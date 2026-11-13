import { describe, expect, it } from "vitest";
import {
  currentMonthKey,
  formatMonthLabel,
  formatDateOnly,
  formatShortMonthLabel,
  InvalidDateError,
  isValidMonthKey,
  isValidTimeZone,
  monthKeysEndingAt,
  monthKeysFrom,
  monthRange,
  parseDateOnly,
  parseMonthKey,
  shiftMonthKey,
  toDateOnlyString,
  todayDateOnly,
  yearRange,
} from "./dates";

describe("isValidMonthKey", () => {
  it("accepts a month that exists, boundaries included", () => {
    expect(isValidMonthKey("2026-01")).toBe(true);
    expect(isValidMonthKey("2026-12")).toBe(true);
  });

  it("rejects a month that does not exist — parseMonthKey would throw on it", () => {
    expect(isValidMonthKey("2026-00")).toBe(false);
    expect(isValidMonthKey("2026-13")).toBe(false);
    expect(isValidMonthKey("2026-99")).toBe(false);
  });

  it("rejects a malformed or absent key", () => {
    expect(isValidMonthKey("2026-1")).toBe(false);
    expect(isValidMonthKey("2026-1a")).toBe(false);
    expect(isValidMonthKey("2026-09-30")).toBe(false);
    expect(isValidMonthKey("")).toBe(false);
    expect(isValidMonthKey(null)).toBe(false);
    expect(isValidMonthKey(undefined)).toBe(false);
  });
});

describe("parseDateOnly", () => {
  it("parses a calendar day at UTC midnight", () => {
    const parsed = parseDateOnly("2026-09-30");

    expect(parsed.toISOString()).toBe("2026-09-30T00:00:00.000Z");
  });

  it("round-trips with toDateOnlyString", () => {
    expect(toDateOnlyString(parseDateOnly("2026-01-01"))).toBe("2026-01-01");
  });

  it("rejects a wrong format", () => {
    expect(() => parseDateOnly("30/09/2026")).toThrow(InvalidDateError);
  });

  it("rejects an impossible day instead of rolling over to the next month", () => {
    expect(() => parseDateOnly("2026-02-31")).toThrow(InvalidDateError);
  });

  it("rejects the 31st of a 30-day month", () => {
    expect(() => parseDateOnly("2026-04-31")).toThrow(InvalidDateError);
  });
});

describe("monthRange", () => {
  it("starts on the first day of the month and ends on the first day of the next", () => {
    const range = monthRange(2026, 9);

    expect(range.start.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(range.end.toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });

  it("uses an exclusive upper bound, so the first of next month is never included", () => {
    const range = monthRange(2026, 9);
    const firstOfNextMonth = parseDateOnly("2026-10-01");

    expect(firstOfNextMonth.getTime() >= range.start.getTime()).toBe(true);
    expect(firstOfNextMonth.getTime() < range.end.getTime()).toBe(false);
  });

  it("crosses the year boundary in December", () => {
    const range = monthRange(2026, 12);

    expect(range.end.toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });

  it("handles a leap February", () => {
    expect(monthRange(2028, 2).end.toISOString()).toBe("2028-03-01T00:00:00.000Z");
  });

  it("rejects an invalid month", () => {
    expect(() => monthRange(2026, 13)).toThrow(RangeError);
    expect(() => monthRange(2026, 0)).toThrow(RangeError);
  });

  it("rejects an invalid year", () => {
    expect(() => monthRange(1900, 1)).toThrow(RangeError);
  });
});

describe("month keys", () => {
  it("derives the current month key", () => {
    expect(currentMonthKey(new Date(Date.UTC(2026, 8, 30)))).toBe("2026-09");
  });

  it("parses a month key", () => {
    expect(parseMonthKey("2026-09")).toMatchObject({ year: 2026, month: 9 });
  });

  it("rejects a malformed month key", () => {
    expect(() => parseMonthKey("2026-9")).toThrow(RangeError);
    expect(() => parseMonthKey("septembre")).toThrow(RangeError);
  });

  it("rejects a month key with an impossible month", () => {
    expect(() => parseMonthKey("2026-13")).toThrow(RangeError);
  });

  it("labels a month in French", () => {
    expect(formatMonthLabel(2026, 9)).toMatch(/septembre/i);
  });
});

describe("date-only formatting", () => {
  it("formats without shifting the day, whatever the local time zone", () => {
    // A date-only value is UTC midnight; displayed in a negative-offset zone it
    // must still read as the 30th.
    expect(formatDateOnly(parseDateOnly("2026-09-30"))).toContain("30");
  });
});

describe("isValidTimeZone", () => {
  it("accepts a known zone", () => {
    expect(isValidTimeZone("Europe/Paris")).toBe(true);
  });

  it("rejects an unknown zone", () => {
    expect(isValidTimeZone("Europe/Atlantis")).toBe(false);
  });
});

describe("monthKeysEndingAt", () => {
  it("returns the window oldest first, ending on the requested month", () => {
    expect(monthKeysEndingAt("2026-09", 3)).toEqual(["2026-07", "2026-08", "2026-09"]);
  });

  it("returns a single month when asked for one", () => {
    expect(monthKeysEndingAt("2026-09", 1)).toEqual(["2026-09"]);
  });

  it("rolls the year back across January", () => {
    // The case that breaks a naive month arithmetic.
    expect(monthKeysEndingAt("2026-01", 3)).toEqual(["2025-11", "2025-12", "2026-01"]);
  });

  it("spans a full year without repeating or skipping a month", () => {
    const keys = monthKeysEndingAt("2026-09", 12);

    expect(keys).toHaveLength(12);
    expect(new Set(keys).size).toBe(12);
    expect(keys[0]).toBe("2025-10");
    expect(keys[11]).toBe("2026-09");
  });

  it("every key is a valid month key", () => {
    for (const key of monthKeysEndingAt("2024-02", 12)) {
      expect(() => parseMonthKey(key)).not.toThrow();
    }
  });

  it("rejects a window that does not make sense", () => {
    expect(() => monthKeysEndingAt("2026-09", 0)).toThrow(RangeError);
    expect(() => monthKeysEndingAt("2026-09", 1.5)).toThrow(RangeError);
  });
});

describe("formatShortMonthLabel", () => {
  it("keeps the abbreviated month and a two-digit year", () => {
    const label = formatShortMonthLabel(2025, 10);

    expect(label).toMatch(/oct/i);
    expect(label).toContain("25");
  });
});

describe("shiftMonthKey", () => {
  it("shifts forward and backward, crossing the year both ways", () => {
    expect(shiftMonthKey("2026-10", 1)).toBe("2026-11");
    expect(shiftMonthKey("2026-10", -1)).toBe("2026-09");
    expect(shiftMonthKey("2026-12", 1)).toBe("2027-01");
    expect(shiftMonthKey("2026-01", -1)).toBe("2025-12");
    expect(shiftMonthKey("2026-01", -13)).toBe("2024-12");
  });

  it("a zero shift keeps the same month", () => {
    expect(shiftMonthKey("2026-10", 0)).toBe("2026-10");
  });

  it("rejects a non-integer offset or an out-of-bounds result", () => {
    expect(() => shiftMonthKey("2026-10", 1.5)).toThrow(RangeError);
    expect(() => shiftMonthKey("0001-01", -1)).toThrow(RangeError);
  });
});

describe("monthKeysFrom", () => {
  it("lists the requested count starting at the given month", () => {
    expect(monthKeysFrom("2026-11", 3)).toEqual(["2026-11", "2026-12", "2027-01"]);
    expect(monthKeysFrom("2026-10", 1)).toEqual(["2026-10"]);
  });

  it("rejects a window that does not make sense", () => {
    expect(() => monthKeysFrom("2026-10", 0)).toThrow(RangeError);
    expect(() => monthKeysFrom("2026-10", 2.5)).toThrow(RangeError);
  });
});

describe("yearRange", () => {
  it("spans the whole year with an exclusive end", () => {
    const range = yearRange(2026);

    expect(toDateOnlyString(range.start)).toBe("2026-01-01");
    expect(toDateOnlyString(range.end)).toBe("2027-01-01");
  });

  it("validates the year through the month bounds", () => {
    expect(() => yearRange(1969)).toThrow(RangeError);
  });
});

describe("todayDateOnly", () => {
  it("uses the owner's calendar day, not the UTC day", () => {
    const lateEvening = new Date("2026-11-10T23:30:00Z");

    expect(toDateOnlyString(todayDateOnly("Europe/Paris", lateEvening))).toBe("2026-11-11");
    expect(toDateOnlyString(todayDateOnly("UTC", lateEvening))).toBe("2026-11-10");
  });

  it("crosses the year boundary in a negative-offset zone", () => {
    const newYear = new Date("2026-01-01T00:30:00Z");

    expect(toDateOnlyString(todayDateOnly("America/New_York", newYear))).toBe("2025-12-31");
  });
});
