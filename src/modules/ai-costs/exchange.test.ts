import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import type { Currency } from "@/lib/money";
import { createCostAmount, type CostAmount } from "./amount";
import {
  assertExchangeRatePair,
  convertCostAmount,
  convertMoney,
  createExchangeRate,
  createExchangeRateSnapshot,
  ExchangeRatePairMismatchError,
  InvalidExchangeRateError,
  parseRateDate,
  type ExchangeRateInput,
  type ExchangeRateSnapshot,
} from "./exchange";
import { costMoney } from "./money";
import { createCostSource, UnsafeSourceReferenceError } from "./source";

const RECORDED_AT = new Date("2026-10-28T12:00:00.000Z");

function rateInput(overrides: Partial<ExchangeRateInput> = {}): ExchangeRateInput {
  return {
    baseCurrency: "USD",
    quoteCurrency: "EUR",
    rate: "0.92",
    rateDate: "2026-10-28",
    source: createCostSource({
      kind: "manual",
      enteredBy: "user-1",
      capturedAt: RECORDED_AT,
    }),
    recordedAt: RECORDED_AT,
    ...overrides,
  };
}

function snapshot(
  overrides: Partial<ExchangeRateInput> = {},
  id = "rate-1",
): ExchangeRateSnapshot {
  return createExchangeRateSnapshot({ id, ...rateInput(overrides) });
}

function cost(amount: string | null, currency = "USD"): CostAmount {
  return createCostAmount({
    money: amount === null ? null : { amount, currency },
    actuality: "observed",
    source: createCostSource({
      kind: "provider",
      provider: "openai",
      externalId: "inv-2026-10",
      capturedAt: RECORDED_AT,
    }),
    operationDate: "2026-10-28",
  });
}

describe("createExchangeRate", () => {
  it("keeps the pair, the exact rate, the calendar day and the source", () => {
    const rate = createExchangeRate(rateInput({ rate: "0.9145378931" }));

    expect(rate.baseCurrency).toBe("USD");
    expect(rate.quoteCurrency).toBe("EUR");
    expect(rate.rate.toFixed(10)).toBe("0.9145378931");
    expect(rate.rateDate).toBe("2026-10-28");
    expect(rate.recordedAt).toBe(RECORDED_AT.toISOString());
    expect(rate.source).toMatchObject({ kind: "manual", enteredBy: "user-1" });
  });

  it("normalises a Date rate day and a zoned instant to UTC", () => {
    const rate = createExchangeRate(
      rateInput({
        rateDate: new Date("2026-10-27T23:30:00.000Z"),
        recordedAt: "2026-10-28T16:00:00+04:00",
      }),
    );

    expect(rate.rateDate).toBe("2026-10-27");
    expect(rate.recordedAt).toBe("2026-10-28T12:00:00.000Z");
  });

  it("returns a frozen value", () => {
    const rate = createExchangeRate(rateInput());

    expect(Object.isFrozen(rate)).toBe(true);
    expect(() => Object.assign(rate, { rate: new Decimal(2) })).toThrow(TypeError);
  });

  it("refuses an identity pair", () => {
    expect(() =>
      createExchangeRate(rateInput({ quoteCurrency: "USD" })),
    ).toThrow(InvalidExchangeRateError);
  });

  it("refuses an unsupported currency", () => {
    expect(() =>
      createExchangeRate(rateInput({ baseCurrency: "JPY" })),
    ).toThrow(InvalidExchangeRateError);
  });

  it("refuses a rate that is zero, negative or not a decimal", () => {
    expect(() => createExchangeRate(rateInput({ rate: "0" }))).toThrow(
      InvalidExchangeRateError,
    );
    expect(() => createExchangeRate(rateInput({ rate: -1 }))).toThrow(
      InvalidExchangeRateError,
    );
    expect(() => createExchangeRate(rateInput({ rate: "0,92" }))).toThrow(
      InvalidExchangeRateError,
    );
    expect(() =>
      createExchangeRate(rateInput({ rate: Number.NaN })),
    ).toThrow(InvalidExchangeRateError);
  });

  it("refuses more than ten decimals instead of rounding the rate", () => {
    expect(() =>
      createExchangeRate(rateInput({ rate: "0.91453789311" })),
    ).toThrow(InvalidExchangeRateError);

    const rate = createExchangeRate(rateInput({ rate: "0.9145378931" }));
    expect(rate.rate.toFixed(10)).toBe("0.9145378931");
  });

  it("refuses an impossible rate day", () => {
    expect(() => createExchangeRate(rateInput({ rateDate: "2026-02-31" }))).toThrow(
      InvalidExchangeRateError,
    );
    expect(() =>
      createExchangeRate(rateInput({ rateDate: "2026-10-28T00:00:00Z" })),
    ).toThrow(InvalidExchangeRateError);
  });

  it("refuses a source that looks like a secret", () => {
    expect(() =>
      createExchangeRate(
        rateInput({
          source: {
            kind: "provider",
            provider: "openai",
            externalId: "sk-abcdefghijklmnop",
            capturedAt: RECORDED_AT,
          },
        }),
      ),
    ).toThrow(UnsafeSourceReferenceError);
  });
});

describe("createExchangeRateSnapshot", () => {
  it("adds the identifier a converted amount references", () => {
    expect(snapshot({}, "rate-42").id).toBe("rate-42");
  });

  it("refuses a missing or unsafe identifier", () => {
    expect(() =>
      createExchangeRateSnapshot({ id: "", ...rateInput() }),
    ).toThrow(InvalidExchangeRateError);
    expect(() =>
      createExchangeRateSnapshot({ id: "rate 1", ...rateInput() }),
    ).toThrow(InvalidExchangeRateError);
  });
});

describe("parseRateDate", () => {
  it("reads a Date as its UTC calendar day", () => {
    expect(parseRateDate(new Date("2026-10-27T23:30:00.000Z"))).toBe("2026-10-27");
  });
});

describe("assertExchangeRatePair", () => {
  it("keeps two distinct supported currencies", () => {
    expect(assertExchangeRatePair("USD", "EUR")).toEqual({
      baseCurrency: "USD",
      quoteCurrency: "EUR",
    });
  });
});

describe("convertMoney", () => {
  it("converts with the snapshot rate and keeps the original amount", () => {
    const converted = convertMoney(costMoney("100", "USD"), snapshot());

    expect(converted.original.amount.toFixed(2)).toBe("100.00");
    expect(converted.original.currency).toBe("USD");
    expect(converted.converted.amount.toFixed(2)).toBe("92.00");
    expect(converted.converted.currency).toBe("EUR");
    expect(converted.snapshotId).toBe("rate-1");
  });

  it("rounds half-up to the cent at the boundary", () => {
    const half = convertMoney(
      costMoney("1", "USD"),
      snapshot({ rate: "0.915" }),
    );
    const below = convertMoney(
      costMoney("1", "USD"),
      snapshot({ rate: "0.9149999999" }),
    );

    expect(half.converted.amount.toFixed(2)).toBe("0.92");
    expect(below.converted.amount.toFixed(2)).toBe("0.91");
  });

  it("rounds a negative tie away from zero", () => {
    const converted = convertMoney(
      costMoney("-1", "USD"),
      snapshot({ rate: "0.915" }),
    );

    expect(converted.converted.amount.toFixed(2)).toBe("-0.92");
  });

  it("uses exact decimal arithmetic, not floating point", () => {
    // 3.35 * 0.3 is 1.005 exactly; in IEEE-754 it is 1.0049999999999999.
    const converted = convertMoney(
      costMoney("3.35", "USD"),
      snapshot({ rate: "0.3" }),
    );

    expect(converted.converted.amount.toFixed(2)).toBe("1.01");
  });

  it("refuses a snapshot taken for another pair", () => {
    expect(() => convertMoney(costMoney("100", "GBP"), snapshot())).toThrow(
      ExchangeRatePairMismatchError,
    );
  });
});

describe("convertCostAmount", () => {
  it("reports the snapshot behind a converted figure", () => {
    const conversion = convertCostAmount(cost("100"), {
      to: "EUR",
      rate: snapshot(),
    });

    expect(conversion.status).toBe("converted");
    if (conversion.status !== "converted") {
      throw new Error("expected a conversion");
    }

    expect(conversion.converted.amount.toFixed(2)).toBe("92.00");
    expect(conversion.original.amount.toFixed(2)).toBe("100.00");
    expect(conversion.snapshot.id).toBe("rate-1");
    expect(conversion.snapshot.rate.toFixed(2)).toBe("0.92");
  });

  it("stays unknown when no rate is recorded", () => {
    const conversion = convertCostAmount(cost("100"), { to: "EUR", rate: null });

    expect(conversion).toMatchObject({
      status: "unknown",
      reason: "missing_rate",
      targetCurrency: "EUR",
    });
    expect(conversion.original?.amount.toFixed(2)).toBe("100.00");
    expect(conversion.original?.currency).toBe("USD");
    expect("converted" in conversion ? conversion.converted : null).toBeNull();
  });

  it("reports a missing amount before a missing rate", () => {
    expect(convertCostAmount(cost(null), { to: "EUR", rate: null })).toMatchObject({
      status: "unknown",
      reason: "missing_amount",
      original: null,
    });
    expect(convertCostAmount(cost(null), { to: "EUR", rate: snapshot() })).toMatchObject({
      status: "unknown",
      reason: "missing_amount",
    });
  });

  it("refuses a snapshot that does not produce the requested currency", () => {
    expect(() =>
      convertCostAmount(cost("100"), {
        to: "GBP" as Currency,
        rate: snapshot(),
      }),
    ).toThrow(ExchangeRatePairMismatchError);
  });

  it("never rewrites a conversion when a newer rate is recorded", () => {
    const first = snapshot({ rate: "0.9" }, "rate-1");
    const before = convertCostAmount(cost("100"), { to: "EUR", rate: first });

    // A newer snapshot of the same day, recorded later: history must not move.
    const newer = snapshot(
      { rate: "1.1", recordedAt: new Date("2026-10-28T18:00:00.000Z") },
      "rate-2",
    );
    const after = convertCostAmount(cost("100"), { to: "EUR", rate: newer });

    expect(before.status).toBe("converted");
    expect(after.status).toBe("converted");
    if (before.status !== "converted" || after.status !== "converted") {
      throw new Error("expected two conversions");
    }

    expect(before.converted.amount.toFixed(2)).toBe("90.00");
    expect(before.snapshot.id).toBe("rate-1");
    expect(after.converted.amount.toFixed(2)).toBe("110.00");
    expect(after.snapshot.id).toBe("rate-2");
  });
});
