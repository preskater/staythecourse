import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { parseDateOnly } from "@/lib/dates";
import {
  forecastCycle,
  MIN_DAYS_WITH_DATA,
  remainingDays,
  upcomingRenewals,
  WINDOW_DAYS,
  windowStart,
  type ForecastInputs,
  type MeteredDay,
} from "./forecast";
import { currentBillingCycle } from "./overview";
import type { AiSubscription } from "./subscriptions";

const d = parseDateOnly;
const cycle = currentBillingCycle(d("2026-11-19"));

/** One metered day per date, same amount, in EUR. */
function days(dates: string[], amount = "10", currency = "EUR"): MeteredDay[] {
  return dates.map((date) => ({ day: d(date), currency, amount: new Decimal(amount) }));
}

function inputs(overrides: Partial<ForecastInputs> = {}): ForecastInputs {
  return {
    meteredToDate: new Map(),
    meteredDays: [],
    subscriptionsBooked: new Map(),
    subscriptions: [],
    ...overrides,
  };
}

function subscription(overrides: Partial<AiSubscription> = {}): AiSubscription {
  return {
    id: "sub-1",
    provider: "openai",
    plan: "Team",
    seats: 2,
    seatPrice: new Decimal("25"),
    currency: "EUR",
    frequency: "MONTHLY",
    startDate: d("2026-08-25"),
    cancelledOn: null,
    allowance: null,
    ownerId: null,
    allocationPolicyId: null,
    createdBy: "user-1",
    notes: null,
    ...overrides,
  };
}

const fourteenDays = Array.from({ length: WINDOW_DAYS }, (_, index) =>
  new Date(windowStart(cycle.today).getTime() + index * 86_400_000).toISOString().slice(0, 10),
);

describe("cycle boundaries", () => {
  it("counts the days left after today, zero on the last day", () => {
    expect(remainingDays(cycle)).toBe(11);
    expect(remainingDays(currentBillingCycle(d("2026-11-30")))).toBe(0);
    expect(remainingDays(currentBillingCycle(d("2026-02-01")))).toBe(27);
    expect(remainingDays(currentBillingCycle(d("2028-02-01")))).toBe(28);
  });

  it("opens the window 14 days back, today included, across the month start", () => {
    expect(windowStart(d("2026-11-19")).toISOString().slice(0, 10)).toBe("2026-11-06");
    expect(windowStart(d("2026-11-03")).toISOString().slice(0, 10)).toBe("2026-10-21");
  });

  it("includes a renewal on the cycle's last day, never one on the next month's first day or past a cancellation", () => {
    const renewals = upcomingRenewals(
      [
        subscription({ startDate: d("2026-08-30") }),
        subscription({ id: "next-month", startDate: d("2026-09-01") }),
        subscription({ id: "today", startDate: d("2026-09-19") }),
        subscription({ id: "cancelled", startDate: d("2026-08-25"), cancelledOn: d("2026-11-25") }),
        subscription({ id: "before-cancel", startDate: d("2026-08-25"), cancelledOn: d("2026-11-26") }),
      ],
      cycle,
    );

    // Today's renewal is already booked: only later dates count as upcoming.
    expect(renewals.map((row) => row.date)).toEqual(["2026-11-30", "2026-11-25"]);
  });
});

describe("forecastCycle", () => {
  it("projects dense metered usage with the window's daily rate, plus subscriptions", () => {
    const [eur] = forecastCycle(
      inputs({
        meteredToDate: new Map([["EUR", new Decimal("190")]]),
        meteredDays: days(fourteenDays),
        subscriptionsBooked: new Map([["EUR", new Decimal("50")]]),
        subscriptions: [subscription()],
      }),
      cycle,
    );

    expect(eur.daysWithData).toBe(14);
    expect(eur.dailyRate?.toFixed(2)).toBe("10.00");
    // 190 + 10 × 11 = 300, + 50 booked + 50 renewing on the 25th.
    expect(eur.meteredForecast?.toFixed(2)).toBe("300.00");
    expect(eur.upcoming.map((row) => [row.date, row.amount.toFixed(2)])).toEqual([["2026-11-25", "50.00"]]);
    expect(eur.total?.toFixed(2)).toBe("400.00");
  });

  it("counts days without spend as zero in the rate, not as missing", () => {
    const [eur] = forecastCycle(
      inputs({ meteredDays: days(fourteenDays.slice(0, 7), "14") }),
      cycle,
    );
    expect(eur.daysWithData).toBe(7);
    expect(eur.dailyRate?.toFixed(2)).toBe("7.00");
  });

  it("reports sparse data as insufficient instead of a figure", () => {
    const sparse = fourteenDays.slice(0, MIN_DAYS_WITH_DATA - 1);
    const [eur] = forecastCycle(
      inputs({
        meteredToDate: new Map([["EUR", new Decimal("40")]]),
        meteredDays: days(sparse),
        subscriptionsBooked: new Map([["EUR", new Decimal("50")]]),
      }),
      cycle,
    );

    expect(eur).toMatchObject({ daysWithData: 4, dailyRate: null, meteredForecast: null, total: null });
    // The parts that are known stay visible.
    expect(eur.subscriptionsBooked.toFixed(2)).toBe("50.00");
  });

  it("ignores spend outside the window and zero days when counting data", () => {
    const [eur] = forecastCycle(
      inputs({
        meteredDays: [
          ...days(["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05"]),
          ...days(fourteenDays.slice(0, 4), "0"),
        ],
      }),
      cycle,
    );
    expect(eur.daysWithData).toBe(0);
    expect(eur.total).toBeNull();
  });

  it("keeps the known spend on the last day, whatever the data", () => {
    const lastDay = currentBillingCycle(d("2026-11-30"));
    const [eur] = forecastCycle(
      inputs({ meteredToDate: new Map([["EUR", new Decimal("123.45")]]), meteredDays: days(["2026-11-30"]) }),
      lastDay,
    );
    expect(eur.total?.toFixed(2)).toBe("123.45");
  });

  it("forecasts each currency apart, refunds included, and a subscription-only currency stays insufficient", () => {
    const rows = forecastCycle(
      inputs({
        meteredToDate: new Map([["EUR", new Decimal("-20")]]),
        meteredDays: [...days(fourteenDays, "-2")],
        subscriptions: [subscription({ currency: "USD" })],
      }),
      cycle,
    );

    expect(rows.map((row) => row.currency)).toEqual(["EUR", "USD"]);
    expect(rows[0].total?.toFixed(2)).toBe("-42.00");
    expect(rows[1]).toMatchObject({ total: null, upcoming: [expect.objectContaining({ date: "2026-11-25" })] });
  });

  it("returns nothing when there is neither spend nor subscription", () => {
    expect(forecastCycle(inputs(), cycle)).toEqual([]);
  });
});
