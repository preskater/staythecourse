import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { computePropertyTotals, type CashflowEntry } from "./domain";
import {
  filterPropertyEvents,
  isPropertyEventOverdue,
  propertyEventDueState,
  propertyEventInputSchema,
  propertyEventUpdateSchema,
  summarizePropertyEvents,
  type PropertyEvent,
} from "./events";

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

function day(year: number, month: number, date: number): Date {
  return new Date(Date.UTC(year, month - 1, date));
}

const TODAY = day(2026, 3, 10);

describe("propertyEventDueState", () => {
  it("marks a planned event with a future date as upcoming", () => {
    expect(propertyEventDueState(event({ dueDate: day(2026, 3, 11) }), TODAY)).toBe("UPCOMING");
  });

  it("marks an event due today as due today, not late", () => {
    expect(propertyEventDueState(event({ dueDate: TODAY }), TODAY)).toBe("DUE_TODAY");
  });

  it("marks a planned event with a past date as overdue", () => {
    expect(propertyEventDueState(event({ dueDate: day(2026, 3, 9) }), TODAY)).toBe("OVERDUE");
  });

  it("never reports a done event as overdue, even with a past date", () => {
    const done = event({ dueDate: day(2026, 3, 1), status: "DONE" });

    expect(propertyEventDueState(done, TODAY)).toBe("DONE");
    expect(isPropertyEventOverdue(done, TODAY)).toBe(false);
  });

  it("never reports a cancelled event as overdue", () => {
    const cancelled = event({ dueDate: day(2026, 3, 1), status: "CANCELLED" });

    expect(propertyEventDueState(cancelled, TODAY)).toBe("CANCELLED");
    expect(isPropertyEventOverdue(cancelled, TODAY)).toBe(false);
  });

  it("keeps an undated event explicit instead of inventing a date", () => {
    expect(propertyEventDueState(event(), TODAY)).toBe("NO_DATE");
    expect(isPropertyEventOverdue(event(), TODAY)).toBe(false);
  });

  it("compares calendar days in UTC, so a time of day cannot move the state", () => {
    const lateInTheDay = new Date("2026-03-10T23:59:59.000Z");

    expect(propertyEventDueState(event({ dueDate: day(2026, 3, 10) }), lateInTheDay)).toBe(
      "DUE_TODAY",
    );
  });

  it("reports a done event without a date as done, not undated", () => {
    expect(propertyEventDueState(event({ status: "DONE" }), TODAY)).toBe("DONE");
  });
});

describe("filterPropertyEvents", () => {
  const events = [
    event({ id: "a", propertyId: "property-1", status: "PLANNED" }),
    event({ id: "b", propertyId: "property-1", status: "DONE" }),
    event({ id: "c", propertyId: "property-2", status: "PLANNED" }),
  ];

  it("keeps every event when the filter is empty", () => {
    expect(filterPropertyEvents(events).map((candidate) => candidate.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("filters by property", () => {
    expect(
      filterPropertyEvents(events, { propertyId: "property-2" }).map((candidate) => candidate.id),
    ).toEqual(["c"]);
  });

  it("filters by status", () => {
    expect(
      filterPropertyEvents(events, { status: "DONE" }).map((candidate) => candidate.id),
    ).toEqual(["b"]);
  });

  it("combines property and status, and returns nothing when they do not match", () => {
    expect(
      filterPropertyEvents(events, { propertyId: "property-1", status: "DONE" }).map(
        (candidate) => candidate.id,
      ),
    ).toEqual(["b"]);
    expect(filterPropertyEvents(events, { propertyId: "property-2", status: "DONE" })).toEqual([]);
  });
});

describe("summarizePropertyEvents", () => {
  it("counts every due state, including overdue and undated events", () => {
    const summary = summarizePropertyEvents(
      [
        event({ id: "overdue", dueDate: day(2026, 3, 1) }),
        event({ id: "today", dueDate: TODAY }),
        event({ id: "upcoming", dueDate: day(2026, 4, 1) }),
        event({ id: "done", dueDate: day(2026, 3, 1), status: "DONE" }),
        event({ id: "cancelled", status: "CANCELLED" }),
        event({ id: "undated" }),
      ],
      TODAY,
    );

    expect(summary).toEqual({
      overdue: 1,
      dueToday: 1,
      upcoming: 1,
      done: 1,
      cancelled: 1,
      withoutDate: 1,
    });
  });
});

describe("event amounts stay out of the financial totals", () => {
  it("summarises events without any monetary aggregate", () => {
    const summary = summarizePropertyEvents(
      [event({ amount: new Decimal("1200.00"), currency: "EUR", dueDate: TODAY })],
      TODAY,
    );

    // The summary carries counts only: no amount, income or expense can leak from it.
    expect(Object.keys(summary).sort()).toEqual([
      "cancelled",
      "done",
      "dueToday",
      "overdue",
      "upcoming",
      "withoutDate",
    ]);
  });

  it("leaves the property cashflow totals untouched", () => {
    const cashflow: CashflowEntry = {
      id: "cashflow-1",
      kind: "INCOME",
      label: "Loyer",
      currency: "EUR",
      amount: new Decimal("900.00"),
      dueDate: null,
      settledAt: null,
      transaction: null,
    };
    const events = [event({ amount: new Decimal("1200.00"), currency: "EUR" })];

    const totals = computePropertyTotals([cashflow], { currency: "EUR" });

    expect(totals.net.toFixed(2)).toBe("900.00");
    expect(events[0].amount?.toFixed(2)).toBe("1200.00");
  });
});

describe("propertyEventInputSchema", () => {
  const valid = {
    propertyId: "property-1",
    kind: "TAX",
    label: "Taxe foncière 2027",
    dueDate: "2027-10-15",
    status: "PLANNED",
    amount: "1200,00",
    currency: "EUR",
    notes: "",
  };

  it("accepts a dated event with an informational amount", () => {
    const parsed = propertyEventInputSchema.safeParse(valid);

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.dueDate?.toISOString()).toBe(
      "2027-10-15T00:00:00.000Z",
    );
    expect(parsed.success && parsed.data.amount?.toFixed(2)).toBe("1200.00");
  });

  it("accepts an undated event and keeps it without an invented date", () => {
    const parsed = propertyEventInputSchema.safeParse({ ...valid, dueDate: "" });

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.dueDate).toBeNull();
  });

  it("clears a currency that has no amount", () => {
    const parsed = propertyEventInputSchema.safeParse({
      ...valid,
      amount: "",
      currency: "EUR",
    });

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.amount).toBeNull();
    expect(parsed.success && parsed.data.currency).toBeNull();
  });

  it("refuses an amount without a currency", () => {
    const parsed = propertyEventInputSchema.safeParse({ ...valid, currency: "" });

    expect(parsed.success).toBe(false);
    expect(parsed.success === false && parsed.error.issues[0]?.path).toEqual(["currency"]);
  });

  it("refuses a zero or negative informational amount", () => {
    expect(propertyEventInputSchema.safeParse({ ...valid, amount: "0" }).success).toBe(false);
    expect(propertyEventInputSchema.safeParse({ ...valid, amount: "-10" }).success).toBe(false);
  });

  it("defaults the status to planned", () => {
    const withoutStatus = { ...valid } as Record<string, string>;
    delete withoutStatus.status;
    const parsed = propertyEventInputSchema.safeParse(withoutStatus);

    expect(parsed.success && parsed.data.status).toBe("PLANNED");
  });

  it("requires the identifier when editing", () => {
    expect(propertyEventUpdateSchema.safeParse(valid).success).toBe(false);
    expect(propertyEventUpdateSchema.safeParse({ ...valid, id: "event-1" }).success).toBe(true);
  });
});
