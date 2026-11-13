import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import {
  billingRateInputSchema,
  canReadInternalRates,
  internalCostRateInputSchema,
  ratePeriodLabel,
  resolveEffectiveRate,
  type RateChangePoint,
} from "./rates";

function point(year: number, month: number, hourlyRate = "50.00"): RateChangePoint {
  return { year, month, hourlyRate: new Decimal(hourlyRate) };
}

describe("resolveEffectiveRate", () => {
  const rates = [point(2026, 1, "50.00"), point(2026, 4, "60.00"), point(2027, 2, "70.00")];

  it("returns no rate before the first change point", () => {
    expect(resolveEffectiveRate(rates, 2025, 12)).toBeNull();
    expect(resolveEffectiveRate([], 2026, 1)).toBeNull();
  });

  it("returns the change point of the exact month", () => {
    expect(resolveEffectiveRate(rates, 2026, 1)?.hourlyRate.toFixed(2)).toBe("50.00");
    expect(resolveEffectiveRate(rates, 2026, 4)?.hourlyRate.toFixed(2)).toBe("60.00");
  });

  it("keeps the previous rate until the next change point", () => {
    expect(resolveEffectiveRate(rates, 2026, 2)?.hourlyRate.toFixed(2)).toBe("50.00");
    expect(resolveEffectiveRate(rates, 2026, 3)?.hourlyRate.toFixed(2)).toBe("50.00");
    expect(resolveEffectiveRate(rates, 2026, 12)?.hourlyRate.toFixed(2)).toBe("60.00");
  });

  it("crosses a year and resolves the latest entry", () => {
    expect(resolveEffectiveRate(rates, 2027, 1)?.hourlyRate.toFixed(2)).toBe("60.00");
    expect(resolveEffectiveRate(rates, 2027, 2)?.hourlyRate.toFixed(2)).toBe("70.00");
    expect(resolveEffectiveRate(rates, 2030, 6)?.hourlyRate.toFixed(2)).toBe("70.00");
  });

  it("is order-independent", () => {
    const shuffled = [rates[2], rates[0], rates[1]];

    expect(resolveEffectiveRate(shuffled, 2026, 5)?.hourlyRate.toFixed(2)).toBe("60.00");
    expect(resolveEffectiveRate(shuffled, 2026, 5)?.hourlyRate.toFixed(2)).toBe(
      resolveEffectiveRate(rates, 2026, 5)?.hourlyRate.toFixed(2),
    );
  });

  it("is deterministic when called twice with the same month", () => {
    const first = resolveEffectiveRate(rates, 2026, 6);
    const second = resolveEffectiveRate(rates, 2026, 6);

    expect(first?.year).toBe(second?.year);
    expect(first?.month).toBe(second?.month);
    expect(first?.hourlyRate.toFixed(2)).toBe(second?.hourlyRate.toFixed(2));
  });
});

describe("canReadInternalRates", () => {
  it("grants the confidential rates to the owner only", () => {
    expect(canReadInternalRates("OWNER")).toBe(true);
    expect(canReadInternalRates("ADMIN")).toBe(false);
    expect(canReadInternalRates("MEMBER")).toBe(false);
    expect(canReadInternalRates("VIEWER")).toBe(false);
  });
});

describe("billingRateInputSchema", () => {
  const base = {
    clientId: "client-1",
    month: "2026-03",
    hourlyRate: "85,00",
    currency: "EUR",
  };

  it("accepts a change point and parses its amount", () => {
    const parsed = billingRateInputSchema.safeParse(base);

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.hourlyRate.toFixed(2)).toBe("85.00");
    expect(parsed.success && parsed.data.month).toBe("2026-03");
  });

  it("requires a client", () => {
    expect(billingRateInputSchema.safeParse({ ...base, clientId: "" }).success).toBe(false);
  });

  it("refuses a malformed month", () => {
    for (const month of ["2026-13", "2026-3", "202603", ""]) {
      expect(billingRateInputSchema.safeParse({ ...base, month }).success, month).toBe(false);
    }
  });

  it("refuses a zero or negative rate", () => {
    expect(billingRateInputSchema.safeParse({ ...base, hourlyRate: "0" }).success).toBe(false);
    expect(billingRateInputSchema.safeParse({ ...base, hourlyRate: "-10" }).success).toBe(false);
  });

  it("refuses an unsupported currency", () => {
    expect(billingRateInputSchema.safeParse({ ...base, currency: "JPY" }).success).toBe(false);
  });
});

describe("internalCostRateInputSchema", () => {
  it("accepts a workspace-level change point without a client", () => {
    const parsed = internalCostRateInputSchema.safeParse({
      month: "2026-03",
      hourlyRate: "48,50",
      currency: "EUR",
    });

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.hourlyRate.toFixed(2)).toBe("48.50");
  });

  it("refuses a malformed month or a non-positive rate", () => {
    expect(
      internalCostRateInputSchema.safeParse({
        month: "2026-00",
        hourlyRate: "48",
        currency: "EUR",
      }).success,
    ).toBe(false);
    expect(
      internalCostRateInputSchema.safeParse({
        month: "2026-03",
        hourlyRate: "0",
        currency: "EUR",
      }).success,
    ).toBe(false);
  });
});

describe("ratePeriodLabel", () => {
  it("names the month a change point is effective from", () => {
    const label = ratePeriodLabel(2026, 3);

    expect(label).toContain("2026");
    expect(label.toLowerCase()).toContain("mars");
  });
});
