import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { parseDateOnly, toDateOnlyString } from "@/lib/dates";
import {
  businessExpenseInputSchema,
  upcomingBusinessExpenses,
  upcomingExpenseTotals,
  type BusinessExpenseRecord,
} from "./expenses";

function expense(overrides: Partial<BusinessExpenseRecord> = {}): BusinessExpenseRecord {
  return {
    id: "expense-1",
    label: "Assurance",
    vendor: null,
    kind: "EXPENSE",
    amount: new Decimal("120.00"),
    currency: "EUR",
    frequency: "MONTHLY",
    startDate: parseDateOnly("2026-01-31"),
    endDate: null,
    notes: null,
    ...overrides,
  };
}

function datesOf(records: ReturnType<typeof upcomingBusinessExpenses>): string[] {
  return records.map(({ date }) => toDateOnlyString(date));
}

describe("upcomingBusinessExpenses", () => {
  it("clamps the renewal day to the month's length and never propagates the clamp", () => {
    const dates = datesOf(
      upcomingBusinessExpenses([expense()], parseDateOnly("2026-01-01"), 4),
    );

    expect(dates).toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]);
  });

  it("handles a leap February", () => {
    const dates = datesOf(
      upcomingBusinessExpenses(
        [expense({ startDate: parseDateOnly("2024-01-31") })],
        parseDateOnly("2024-01-01"),
        2,
      ),
    );

    expect(dates).toEqual(["2024-01-31", "2024-02-29"]);
  });

  it("counts a quarterly cadence from the start month", () => {
    const dates = datesOf(
      upcomingBusinessExpenses(
        [expense({ frequency: "QUARTERLY", startDate: parseDateOnly("2026-02-15") })],
        parseDateOnly("2026-01-01"),
        12,
      ),
    );

    expect(dates).toEqual(["2026-02-15", "2026-05-15", "2026-08-15", "2026-11-15"]);
  });

  it("counts a yearly cadence from the start month", () => {
    const dates = datesOf(
      upcomingBusinessExpenses(
        [expense({ frequency: "YEARLY", startDate: parseDateOnly("2026-03-10") })],
        parseDateOnly("2026-01-01"),
        24,
      ),
    );

    expect(dates).toEqual(["2026-03-10", "2027-03-10"]);
  });

  it("keeps the end date inclusive", () => {
    const dates = datesOf(
      upcomingBusinessExpenses(
        [expense({ startDate: parseDateOnly("2026-01-10"), endDate: parseDateOnly("2026-03-10") })],
        parseDateOnly("2026-01-01"),
        12,
      ),
    );

    expect(dates).toEqual(["2026-01-10", "2026-02-10", "2026-03-10"]);
  });

  it("includes a renewal due today and drops the ones before it", () => {
    const included = datesOf(
      upcomingBusinessExpenses([expense({ startDate: parseDateOnly("2026-02-10") })], parseDateOnly("2026-02-10"), 1),
    );
    const excluded = datesOf(
      upcomingBusinessExpenses([expense({ startDate: parseDateOnly("2026-02-10") })], parseDateOnly("2026-02-11"), 1),
    );

    expect(included).toEqual(["2026-02-10"]);
    expect(excluded).toEqual([]);
  });

  it("normalises a time left on the reference day", () => {
    const dates = datesOf(
      upcomingBusinessExpenses(
        [expense({ startDate: parseDateOnly("2026-02-10") })],
        new Date("2026-02-10T23:30:00Z"),
        1,
      ),
    );

    expect(dates).toEqual(["2026-02-10"]);
  });

  it("starts the window at the reference month", () => {
    const dates = datesOf(
      upcomingBusinessExpenses(
        [expense({ startDate: parseDateOnly("2026-10-01") })],
        parseDateOnly("2026-11-15"),
        2,
      ),
    );

    expect(dates).toEqual(["2026-12-01"]);
  });

  it("is duplicate-free when recomputed", () => {
    const records = upcomingBusinessExpenses(
      [
        expense(),
        expense({ id: "expense-2", label: "Logiciel", amount: new Decimal("20.00") }),
      ],
      parseDateOnly("2026-01-01"),
      12,
    );
    const again = upcomingBusinessExpenses(
      [
        expense(),
        expense({ id: "expense-2", label: "Logiciel", amount: new Decimal("20.00") }),
      ],
      parseDateOnly("2026-01-01"),
      12,
    );

    expect(datesOf(records)).toEqual(datesOf(again));
    expect(records).toHaveLength(24);
    expect(new Set(records.map((entry) => `${entry.expense.id}-${datesOf([entry])[0]}`)).size).toBe(24);
  });

  it("sorts by date then label", () => {
    const records = upcomingBusinessExpenses(
      [
        expense({ id: "b", label: "B", startDate: parseDateOnly("2026-01-10") }),
        expense({ id: "a", label: "A", startDate: parseDateOnly("2026-01-10") }),
        expense({ id: "c", label: "C", startDate: parseDateOnly("2026-01-01") }),
      ],
      parseDateOnly("2026-01-01"),
      1,
    );

    expect(records.map(({ expense: record }) => record.label)).toEqual(["C", "A", "B"]);
  });

  it("rejects an empty or non-integer window", () => {
    expect(() => upcomingBusinessExpenses([expense()], parseDateOnly("2026-01-01"), 0)).toThrow(
      RangeError,
    );
    expect(() =>
      upcomingBusinessExpenses([expense()], parseDateOnly("2026-01-01"), 1.5),
    ).toThrow(RangeError);
  });
});

describe("upcomingExpenseTotals", () => {
  it("groups by currency without converting and counts the renewals", () => {
    const records = upcomingBusinessExpenses(
      [
        expense({ id: "eur", label: "EUR", amount: new Decimal("100.00") }),
        expense({ id: "usd", label: "USD", amount: new Decimal("40.00"), currency: "USD" }),
      ],
      parseDateOnly("2026-01-01"),
      3,
    );
    const totals = upcomingExpenseTotals(records);

    expect(totals.map((total) => total.currency)).toEqual(["EUR", "USD"]);
    expect(totals[0].total.toFixed(2)).toBe("300.00");
    expect(totals[0].count).toBe(3);
    expect(totals[1].total.toFixed(2)).toBe("120.00");
  });

  it("returns no row for an empty window", () => {
    expect(upcomingExpenseTotals([])).toEqual([]);
  });
});

describe("businessExpenseInputSchema", () => {
  const base = {
    label: "Assurance RC",
    vendor: "Mutuelle",
    kind: "OBLIGATION",
    amount: "120,00",
    currency: "EUR",
    frequency: "YEARLY",
    startDate: "2026-03-10",
    endDate: "",
    notes: "",
  };

  it("accepts a definition and parses its amount and dates", () => {
    const parsed = businessExpenseInputSchema.safeParse(base);

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.amount.toFixed(2)).toBe("120.00");
    expect(parsed.success && parsed.data.endDate).toBeNull();
    expect(parsed.success && parsed.data.startDate.toISOString().slice(0, 10)).toBe(
      "2026-03-10",
    );
  });

  it("refuses a non-positive amount", () => {
    expect(businessExpenseInputSchema.safeParse({ ...base, amount: "0" }).success).toBe(false);
    expect(businessExpenseInputSchema.safeParse({ ...base, amount: "-10" }).success).toBe(false);
  });

  it("refuses an end date before the start date but allows the same day", () => {
    expect(
      businessExpenseInputSchema.safeParse({ ...base, endDate: "2026-03-09" }).success,
    ).toBe(false);
    expect(
      businessExpenseInputSchema.safeParse({ ...base, endDate: "2026-03-10" }).success,
    ).toBe(true);
  });

  it("refuses an unknown kind, cadence or currency", () => {
    expect(businessExpenseInputSchema.safeParse({ ...base, kind: "OTHER" }).success).toBe(false);
    expect(
      businessExpenseInputSchema.safeParse({ ...base, frequency: "WEEKLY" }).success,
    ).toBe(false);
    expect(businessExpenseInputSchema.safeParse({ ...base, currency: "JPY" }).success).toBe(false);
  });
});
