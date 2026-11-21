import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { parseDateOnly, toDateOnlyString } from "@/lib/dates";
import {
  aiSubscriptionInputSchema,
  allowanceUsage,
  currentPeriod,
  dueRenewals,
  MAX_RENEWALS_PER_PASS,
  nextRenewal,
  periodCost,
  renewalPeriod,
  subscriptionPolicyMeasures,
  toSubscriptionRows,
  type AiSubscription,
} from "./subscriptions";

const d = parseDateOnly;
const days = (dates: Date[]) => dates.map(toDateOnlyString);

function subscription(overrides: Partial<AiSubscription> = {}): AiSubscription {
  return {
    id: "sub-1",
    provider: "openai",
    plan: "Team",
    seats: 3,
    seatPrice: new Decimal("25.00"),
    currency: "EUR",
    frequency: "MONTHLY",
    startDate: d("2026-08-31"),
    cancelledOn: null,
    allowance: null,
    ownerId: null,
    allocationPolicyId: null,
    createdBy: "user-1",
    notes: null,
    ...overrides,
  };
}

describe("renewal boundaries", () => {
  it("renews monthly on the start day, clamped to short months, today included", () => {
    expect(days(dueRenewals(subscription(), d("2026-11-30")))).toEqual([
      "2026-08-31",
      "2026-09-30",
      "2026-10-31",
      "2026-11-30",
    ]);
    expect(days(dueRenewals(subscription(), d("2026-11-29")))).toEqual(["2026-08-31", "2026-09-30", "2026-10-31"]);
  });

  it("follows quarterly and yearly cadences from the start month", () => {
    const quarterly = subscription({ frequency: "QUARTERLY", startDate: d("2026-02-15") });
    expect(days(dueRenewals(quarterly, d("2026-11-19")))).toEqual(["2026-02-15", "2026-05-15", "2026-08-15", "2026-11-15"]);

    const yearly = subscription({ frequency: "YEARLY", startDate: d("2024-02-29") });
    expect(days(dueRenewals(yearly, d("2026-11-19")))).toEqual(["2024-02-29", "2025-02-28", "2026-02-28"]);
  });

  it("books nothing before the start date", () => {
    expect(dueRenewals(subscription({ startDate: d("2026-12-01") }), d("2026-11-30"))).toEqual([]);
  });

  it("never books the cancellation day nor anything after, and keeps what came before", () => {
    const cancelled = subscription({ startDate: d("2026-08-15"), cancelledOn: d("2026-10-15") });
    expect(days(dueRenewals(cancelled, d("2026-11-30")))).toEqual(["2026-08-15", "2026-09-15"]);

    const dayAfter = subscription({ startDate: d("2026-08-15"), cancelledOn: d("2026-10-16") });
    expect(days(dueRenewals(dayAfter, d("2026-11-30")))).toEqual(["2026-08-15", "2026-09-15", "2026-10-15"]);
    expect(nextRenewal(dayAfter, d("2026-11-30"))).toBeNull();
  });

  it("shows the next renewal before a scheduled cancellation, and none from its day on", () => {
    const later = subscription({ startDate: d("2026-08-15"), cancelledOn: d("2026-12-16") });
    expect(toDateOnlyString(nextRenewal(later, d("2026-11-19"))!)).toBe("2026-12-15");

    const onTheDay = subscription({ startDate: d("2026-08-15"), cancelledOn: d("2026-12-15") });
    expect(nextRenewal(onTheDay, d("2026-11-19"))).toBeNull();
    // Already-due renewals are unaffected by a cancellation still to come.
    expect(days(dueRenewals(onTheDay, d("2026-11-19")))).toHaveLength(4);
  });

  it("bounds one pass to the most recent renewals", () => {
    const old = subscription({ startDate: d("2010-01-01") });
    const due = dueRenewals(old, d("2026-11-19"));
    expect(due).toHaveLength(MAX_RENEWALS_PER_PASS);
    expect(toDateOnlyString(due.at(-1)!)).toBe("2026-11-01");
  });

  it("covers each paid period up to the day before the next renewal", () => {
    const period = renewalPeriod(subscription(), d("2026-09-30"));
    expect([toDateOnlyString(period.start), toDateOnlyString(period.end)]).toEqual(["2026-09-30", "2026-10-30"]);

    const yearly = renewalPeriod(subscription({ frequency: "YEARLY", startDate: d("2026-03-01") }), d("2026-03-01"));
    expect(toDateOnlyString(yearly.end)).toBe("2027-02-28");
  });

  it("finds the current period, and none once cancelled", () => {
    const period = currentPeriod(subscription(), d("2026-11-19"));
    expect([toDateOnlyString(period!.start), toDateOnlyString(period!.end)]).toEqual(["2026-10-31", "2026-11-29"]);
    expect(currentPeriod(subscription({ cancelledOn: d("2026-11-01") }), d("2026-11-19"))).toBeNull();
    expect(toDateOnlyString(nextRenewal(subscription(), d("2026-11-19"))!)).toBe("2026-11-30");
  });
});

describe("cost, allowance and overage", () => {
  it("costs seats × seat price, exactly", () => {
    expect(periodCost(subscription({ seats: 3, seatPrice: new Decimal("19.99") })).toFixed(2)).toBe("59.97");
  });

  it("tells within, exactly at, past the allowance and no data apart", () => {
    const allowance = new Decimal("100");
    expect(allowanceUsage(null, new Decimal(5))).toEqual({ state: "no-allowance" });
    expect(allowanceUsage(allowance, null)).toEqual({ state: "no-data" });

    const within = allowanceUsage(allowance, new Decimal("100"));
    expect(within.state).toBe("within");
    expect(within.state === "within" && within.remaining.toFixed(2)).toBe("0.00");

    const overage = allowanceUsage(allowance, new Decimal("130.50"));
    expect(overage.state === "overage" && overage.overage.toFixed(2)).toBe("30.50");

    // Refunds larger than usage never invent an overage.
    expect(allowanceUsage(allowance, new Decimal("-10")).state).toBe("within");
  });
});

describe("allocation", () => {
  it("gives every target one seat, needs no measure for percentage or revenue, refuses the rest", () => {
    expect(subscriptionPolicyMeasures("EQUAL_SEAT", 3)?.map(String)).toEqual(["1", "1", "1"]);
    expect(subscriptionPolicyMeasures("FIXED_PERCENTAGE", 2)).toBeUndefined();
    expect(subscriptionPolicyMeasures("REVENUE_WEIGHTED", 2)).toBeUndefined();
    expect(() => subscriptionPolicyMeasures("MANUAL", 2)).toThrow();
    expect(() => subscriptionPolicyMeasures("USAGE_WEIGHTED", 2)).toThrow();
  });
});

describe("aiSubscriptionInputSchema", () => {
  const valid = {
    provider: "openai",
    plan: "Team",
    seats: "3",
    seatPrice: "25,00",
    currency: "EUR",
    frequency: "MONTHLY",
    startDate: "2026-11-01",
    allowance: "",
    ownerId: "",
    allocationPolicyId: "",
    notes: "",
  };

  it("accepts a complete subscription and normalises empty optional fields", () => {
    const parsed = aiSubscriptionInputSchema.safeParse(valid);
    expect(parsed.success).toBe(true);
    expect(parsed.success && [parsed.data.seats, parsed.data.allowance, parsed.data.allocationPolicyId]).toEqual([3, null, null]);
  });

  it.each([
    ["seats", "0"],
    ["seats", "1.5"],
    ["seatPrice", "0"],
    ["allowance", "-1"],
    ["startDate", "2026-02-31"],
    ["frequency", "WEEKLY"],
    ["currency", "XYZ"],
    ["provider", "sk-abcdefghijklmnopqrstuvwxyz123456"],
  ])("refuses %s = %j", (field, value) => {
    expect(aiSubscriptionInputSchema.safeParse({ ...valid, [field]: value }).success).toBe(false);
  });
});

describe("toSubscriptionRows", () => {
  it("returns strings only, and shows a missing measure as such, never 0 used", () => {
    const rows = toSubscriptionRows(
      [
        { ...subscription({ allowance: new Decimal("50") }), renewalCount: 4 },
        { ...subscription({ id: "sub-2", cancelledOn: d("2026-11-01") }), renewalCount: 2 },
      ],
      new Map([["sub-1", null]]),
      new Map(),
      d("2026-11-19"),
    );

    for (const row of rows) {
      for (const value of Object.values(row)) expect(["string", "boolean"]).toContain(typeof value);
    }
    expect(rows[0].allowance).toContain("Aucune consommation mesurée");
    expect(rows[0].status).toContain("30/11/2026");
    expect(rows[1]).toMatchObject({ cancelled: true, renewals: "2" });
    expect(rows[0].cost).toContain("75,00");
  });
});
