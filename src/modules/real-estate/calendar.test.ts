import { describe, expect, it } from "vitest";
import {
  buildCalendarEntries,
  buildCalendarMonth,
  calendarStatusFromDueState,
  cashflowDueState,
  filterCalendarEntries,
  sortCalendarEntries,
  type CalendarCashflow,
  type CalendarEntry,
} from "./calendar";
import type { PropertyEvent } from "./events";

/** Fictitious data only: no real property, amount or note appears here. */
function event(overrides: Partial<PropertyEvent> = {}): PropertyEvent {
  return {
    id: "event-1",
    propertyId: "property-1",
    propertyName: "Bien de test",
    kind: "TAX",
    label: "Taxe foncière",
    dueDate: null,
    status: "PLANNED",
    amount: null,
    currency: null,
    notes: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function cashflow(overrides: Partial<CalendarCashflow> = {}): CalendarCashflow {
  return {
    id: "cashflow-1",
    propertyId: "property-1",
    propertyName: "Bien de test",
    kind: "EXPENSE",
    label: "Charges de copropriété",
    dueDate: null,
    settledAt: null,
    ...overrides,
  };
}

function day(year: number, month: number, date: number): Date {
  return new Date(Date.UTC(year, month - 1, date));
}

function entry(overrides: Partial<CalendarEntry> = {}): CalendarEntry {
  return {
    id: "event:entry-1",
    sourceId: "entry-1",
    source: "EVENT",
    propertyId: "property-1",
    propertyName: "Bien de test",
    label: "Échéance de test",
    dueDate: day(2026, 10, 1),
    dueState: "UPCOMING",
    status: "OPEN",
    kindLabel: "Taxe",
    ...overrides,
  };
}

const TODAY = day(2026, 3, 10);

describe("calendarStatusFromDueState", () => {
  it("maps the open states to OPEN", () => {
    expect(calendarStatusFromDueState("OVERDUE")).toBe("OPEN");
    expect(calendarStatusFromDueState("DUE_TODAY")).toBe("OPEN");
    expect(calendarStatusFromDueState("UPCOMING")).toBe("OPEN");
    expect(calendarStatusFromDueState("NO_DATE")).toBe("OPEN");
  });

  it("keeps done and cancelled distinct", () => {
    expect(calendarStatusFromDueState("DONE")).toBe("DONE");
    expect(calendarStatusFromDueState("CANCELLED")).toBe("CANCELLED");
  });
});

describe("cashflowDueState", () => {
  it("is upcoming before the due date and overdue after it", () => {
    expect(cashflowDueState(cashflow({ dueDate: day(2026, 3, 11) }), TODAY)).toBe("UPCOMING");
    expect(cashflowDueState(cashflow({ dueDate: day(2026, 3, 9) }), TODAY)).toBe("OVERDUE");
  });

  it("is due today on the day itself", () => {
    expect(cashflowDueState(cashflow({ dueDate: TODAY }), TODAY)).toBe("DUE_TODAY");
  });

  it("is done once settled, even when the due date is past", () => {
    expect(
      cashflowDueState(cashflow({ dueDate: day(2026, 3, 1), settledAt: day(2026, 3, 5) }), TODAY),
    ).toBe("DONE");
  });

  it("is undated, not overdue, without a due date", () => {
    expect(cashflowDueState(cashflow(), TODAY)).toBe("NO_DATE");
  });
});

describe("buildCalendarEntries", () => {
  it("maps event statuses and keeps the recorded calendar day", () => {
    const entries = buildCalendarEntries({
      events: [
        event({ id: "planned", dueDate: day(2026, 3, 12), status: "PLANNED" }),
        event({ id: "done", dueDate: day(2026, 3, 1), status: "DONE" }),
        event({ id: "cancelled", dueDate: day(2026, 3, 2), status: "CANCELLED" }),
      ],
      cashflows: [],
      today: TODAY,
    });

    expect(entries.map((candidate) => [candidate.sourceId, candidate.status, candidate.dueState])).toEqual([
      ["planned", "OPEN", "UPCOMING"],
      ["done", "DONE", "DONE"],
      ["cancelled", "CANCELLED", "CANCELLED"],
    ]);
    expect(entries[0]?.dueDate).toEqual(day(2026, 3, 12));
  });

  it("treats an unsettled cashflow as open and a settled one as done", () => {
    const entries = buildCalendarEntries({
      events: [],
      cashflows: [
        cashflow({ id: "open", dueDate: day(2026, 3, 11) }),
        cashflow({ id: "settled", dueDate: day(2026, 3, 1), settledAt: day(2026, 3, 5) }),
      ],
      today: TODAY,
    });

    expect(entries.map((candidate) => [candidate.sourceId, candidate.status, candidate.dueState])).toEqual([
      ["open", "OPEN", "UPCOMING"],
      ["settled", "DONE", "DONE"],
    ]);
  });

  it("keeps an undated entry undated instead of borrowing a date", () => {
    const entries = buildCalendarEntries({
      events: [event({ dueDate: null, status: "PLANNED" })],
      cashflows: [cashflow({ dueDate: null, settledAt: null })],
      today: TODAY,
    });

    expect(entries.every((candidate) => candidate.dueDate === null)).toBe(true);
    expect(entries.every((candidate) => candidate.dueState === "NO_DATE")).toBe(true);
    expect(entries.every((candidate) => candidate.status === "OPEN")).toBe(true);
  });

  it("carries the property and a namespaced identifier", () => {
    const events = buildCalendarEntries({
      events: [event({ id: "shared", propertyId: "property-1", propertyName: "Bien A" })],
      cashflows: [],
      today: TODAY,
    });
    const cashflows = buildCalendarEntries({
      events: [],
      cashflows: [cashflow({ id: "shared", propertyId: "property-2", propertyName: "Bien B" })],
      today: TODAY,
    });

    expect(events[0]?.id).toBe("event:shared");
    expect(cashflows[0]?.id).toBe("cashflow:shared");
    expect(events[0]?.propertyId).toBe("property-1");
    expect(cashflows[0]?.propertyName).toBe("Bien B");
  });

  it("labels each source with its own nature", () => {
    const entries = buildCalendarEntries({
      events: [event({ kind: "INSURANCE" })],
      cashflows: [cashflow({ kind: "INCOME" })],
      today: TODAY,
    });

    expect(entries.map((candidate) => [candidate.source, candidate.kindLabel])).toEqual([
      ["EVENT", "Assurance"],
      ["CASHFLOW", "Recette"],
    ]);
  });
});

describe("filterCalendarEntries", () => {
  const entries = buildCalendarEntries({
    events: [
      event({ id: "a", propertyId: "property-1", status: "PLANNED" }),
      event({ id: "b", propertyId: "property-1", status: "DONE" }),
      event({ id: "c", propertyId: "property-2", status: "CANCELLED" }),
    ],
    cashflows: [cashflow({ id: "d", propertyId: "property-2", settledAt: day(2026, 3, 1) })],
    today: TODAY,
  });

  it("keeps every entry when the filter is empty", () => {
    expect(filterCalendarEntries(entries)).toHaveLength(4);
  });

  it("filters by property", () => {
    expect(
      filterCalendarEntries(entries, { propertyId: "property-2" }).map((candidate) => candidate.sourceId),
    ).toEqual(["c", "d"]);
  });

  it("filters by calendar status across both sources", () => {
    expect(
      filterCalendarEntries(entries, { status: "OPEN" }).map((candidate) => candidate.sourceId),
    ).toEqual(["a"]);
    expect(
      filterCalendarEntries(entries, { status: "DONE" }).map((candidate) => candidate.sourceId),
    ).toEqual(["b", "d"]);
    expect(
      filterCalendarEntries(entries, { status: "CANCELLED" }).map((candidate) => candidate.sourceId),
    ).toEqual(["c"]);
  });

  it("combines property and status and returns nothing when they do not match", () => {
    expect(
      filterCalendarEntries(entries, { propertyId: "property-1", status: "DONE" }).map(
        (candidate) => candidate.sourceId,
      ),
    ).toEqual(["b"]);
    expect(filterCalendarEntries(entries, { propertyId: "property-2", status: "OPEN" })).toEqual([]);
  });
});

describe("sortCalendarEntries", () => {
  it("keeps dated entries chronological and undated entries last", () => {
    const sorted = sortCalendarEntries([
      entry({ id: "undated", dueDate: null }),
      entry({ id: "late", dueDate: day(2026, 10, 31) }),
      entry({ id: "early", dueDate: day(2026, 10, 1) }),
    ]);

    expect(sorted.map((candidate) => candidate.id)).toEqual(["early", "late", "undated"]);
  });

  it("breaks a same-day tie by property and label", () => {
    const sorted = sortCalendarEntries([
      entry({ id: "b", propertyName: "Bien B", label: "Taxe" }),
      entry({ id: "a", propertyName: "Bien A", label: "Taxe" }),
    ]);

    expect(sorted.map((candidate) => candidate.id)).toEqual(["a", "b"]);
  });

  it("does not mutate the input", () => {
    const input = [entry({ id: "late", dueDate: day(2026, 10, 31) }), entry({ id: "early", dueDate: day(2026, 10, 1) })];
    const copy = [...input];

    sortCalendarEntries(input);

    expect(input).toEqual(copy);
  });
});

describe("buildCalendarMonth", () => {
  it("pads October 2026 (starting on a Thursday) to complete weeks", () => {
    const month = buildCalendarMonth([], { year: 2026, month: 10, todayKey: "2026-10-15" });

    expect(month.cells).toHaveLength(35);
    expect(month.cells.slice(0, 3).map((cell) => cell.date)).toEqual([null, null, null]);
    expect(month.cells[3]?.date).toBe("2026-10-01");
    expect(month.cells[33]?.date).toBe("2026-10-31");
    expect(month.cells[34]?.date).toBeNull();
    expect(month.cells.filter((cell) => cell.isToday).map((cell) => cell.date)).toEqual([
      "2026-10-15",
    ]);
  });

  it("places six leading blanks when February 2026 starts on a Sunday", () => {
    const month = buildCalendarMonth([], { year: 2026, month: 2, todayKey: null });

    expect(month.cells.slice(0, 6).every((cell) => cell.date === null)).toBe(true);
    expect(month.cells[6]?.date).toBe("2026-02-01");
    expect(month.cells).toHaveLength(35);
  });

  it("needs no padding when February 2027 starts on a Monday and fills four weeks", () => {
    const month = buildCalendarMonth([], { year: 2027, month: 2, todayKey: null });

    expect(month.cells).toHaveLength(28);
    expect(month.cells.every((cell) => cell.date !== null)).toBe(true);
    expect(month.cells[0]?.date).toBe("2027-02-01");
    expect(month.cells[27]?.date).toBe("2027-02-28");
  });

  it("includes the leap day in February 2028", () => {
    const month = buildCalendarMonth([], { year: 2028, month: 2, todayKey: null });

    const dates = month.cells
      .map((cell) => cell.date)
      .filter((date): date is string => date !== null);

    expect(dates).toHaveLength(29);
    expect(dates[0]).toBe("2028-02-01");
    expect(dates[28]).toBe("2028-02-29");
    expect(month.cells).toHaveLength(35);
  });

  it("pads a month that ends mid-week to the last complete week", () => {
    const month = buildCalendarMonth([], { year: 2026, month: 8, todayKey: null });

    // August 2026 starts on a Saturday: 5 leading blanks, 31 days, 6 trailing blanks.
    expect(month.cells).toHaveLength(42);
    expect(month.cells[5]?.date).toBe("2026-08-01");
    expect(month.cells[35]?.date).toBe("2026-08-31");
    expect(month.cells.slice(36).every((cell) => cell.date === null)).toBe(true);
  });

  it("places each dated entry in its day and leaves other months out", () => {
    const month = buildCalendarMonth(
      [
        entry({ id: "oct-1", dueDate: day(2026, 10, 1) }),
        entry({ id: "oct-31", dueDate: day(2026, 10, 31) }),
        entry({ id: "sep-30", dueDate: day(2026, 9, 30) }),
        entry({ id: "nov-1", dueDate: day(2026, 11, 1) }),
        entry({ id: "undated", dueDate: null }),
      ],
      { year: 2026, month: 10, todayKey: null },
    );

    expect(month.cells.find((cell) => cell.date === "2026-10-01")?.entries.map((candidate) => candidate.id)).toEqual([
      "oct-1",
    ]);
    expect(month.cells.find((cell) => cell.date === "2026-10-31")?.entries.map((candidate) => candidate.id)).toEqual([
      "oct-31",
    ]);
    expect(month.entries.map((candidate) => candidate.id)).toEqual(["oct-1", "oct-31"]);
    expect(month.cells.flatMap((cell) => cell.entries).map((candidate) => candidate.id)).not.toContain("sep-30");
    expect(month.cells.flatMap((cell) => cell.entries).map((candidate) => candidate.id)).not.toContain("nov-1");
  });

  it("never places an undated entry in a cell", () => {
    const month = buildCalendarMonth(
      [entry({ id: "undated", dueDate: null }), entry({ id: "dated", dueDate: day(2026, 10, 10) })],
      { year: 2026, month: 10, todayKey: null },
    );

    expect(month.undatedCount).toBe(1);
    expect(month.cells.every((cell) => !cell.entries.some((candidate) => candidate.id === "undated"))).toBe(true);
    expect(month.entries.map((candidate) => candidate.id)).toEqual(["dated"]);
  });

  it("returns a complete grid for an empty month", () => {
    const month = buildCalendarMonth([], { year: 2027, month: 2, todayKey: null });

    expect(month.entries).toEqual([]);
    expect(month.undatedCount).toBe(0);
    expect(month.cells).toHaveLength(28);
    expect(month.cells.every((cell) => cell.entries.length === 0)).toBe(true);
  });

  it("groups by the UTC calendar day, not by an instant's time of day", () => {
    const lateOnTheThirtyFirst = entry({
      id: "late",
      dueDate: new Date("2026-10-31T23:59:59.000Z"),
    });
    const month = buildCalendarMonth([lateOnTheThirtyFirst], {
      year: 2026,
      month: 10,
      todayKey: null,
    });

    expect(month.cells.find((cell) => cell.date === "2026-10-31")?.entries).toHaveLength(1);
    expect(month.entries.map((candidate) => candidate.id)).toEqual(["late"]);
  });

  it("never lets the first day of the next month enter the grid", () => {
    const month = buildCalendarMonth(
      [entry({ id: "next", dueDate: new Date("2026-11-01T00:00:00.000Z") })],
      { year: 2026, month: 10, todayKey: null },
    );

    expect(month.entries).toEqual([]);
    expect(month.cells.flatMap((cell) => cell.entries)).toEqual([]);
  });
});
