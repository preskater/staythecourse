import { describe, expect, it } from "vitest";
import { randomInt, seededRandom } from "@/invariants/helpers";
import {
  allocateCents,
  assertAllocationConservation,
  assertAllocationSigns,
  fromCents,
  InvalidAllocationMathError,
  splitEvenly,
  summarizeAllocation,
  toCents,
} from "./allocation";

const ZERO = BigInt(0);
const ONE = BigInt(1);

function sum(values: readonly bigint[]): bigint {
  return values.reduce((total, value) => total + value, ZERO);
}

describe("toCents", () => {
  it("converts exact two-decimal amounts without floating point", () => {
    expect(toCents("12.34")).toBe(BigInt(1234));
    expect(toCents("-0.01")).toBe(BigInt(-1));
    expect(toCents(0)).toBe(ZERO);
    expect(toCents("9999999999999999.99")).toBe(
      BigInt("999999999999999999"),
    );
  });

  it("rejects more than two decimals instead of rounding silently", () => {
    expect(() => toCents("1.005")).toThrow(InvalidAllocationMathError);
    expect(() => toCents("0.0001")).toThrow(InvalidAllocationMathError);
  });

  it("round-trips through fromCents", () => {
    expect(fromCents(BigInt(1234)).toFixed(2)).toBe("12.34");
    expect(fromCents(BigInt(-1)).toFixed(2)).toBe("-0.01");
  });
});

describe("allocateCents", () => {
  it("conserves the total exactly for random totals and weights", () => {
    const random = seededRandom(42);

    for (let run = 0; run < 500; run += 1) {
      const total = BigInt(randomInt(random, -100_000, 100_000));
      const count = randomInt(random, 1, 12);
      const weights = Array.from({ length: count }, () =>
        BigInt(randomInt(random, 0, 20)),
      );

      if (weights.every((weight) => weight === ZERO)) {
        weights[0] = ONE;
      }

      const shares = allocateCents(total, weights);

      expect(shares).toHaveLength(count);
      expect(sum(shares)).toBe(total);

      for (const share of shares) {
        expect(share === ZERO || (share < ZERO) === (total < ZERO)).toBe(true);
      }
    }
  });

  it("gives the leftover cents to the largest remainders", () => {
    expect(allocateCents(BigInt(10), [ONE, ONE, ONE])).toEqual([
      BigInt(4),
      BigInt(3),
      BigInt(3),
    ]);
    expect(allocateCents(BigInt(100), [ONE, BigInt(2), BigInt(3)])).toEqual([
      BigInt(17),
      BigInt(33),
      BigInt(50),
    ]);
  });

  it("breaks remainder ties by input order, deterministically", () => {
    expect(allocateCents(ONE, [ONE, ONE])).toEqual([ONE, ZERO]);
    expect(allocateCents(BigInt(5), [ONE, ONE])).toEqual([
      BigInt(3),
      BigInt(2),
    ]);
  });

  it("keeps the sign of a credit and splits its absolute value", () => {
    expect(allocateCents(BigInt(-100), [ONE, ONE, ONE])).toEqual([
      BigInt(-34),
      BigInt(-33),
      BigInt(-33),
    ]);
  });

  it("gives nothing to a zero weight", () => {
    expect(allocateCents(BigInt(10), [ZERO, ONE])).toEqual([
      ZERO,
      BigInt(10),
    ]);
  });

  it("returns zero shares for a zero total", () => {
    expect(allocateCents(ZERO, [ONE, BigInt(2)])).toEqual([ZERO, ZERO]);
  });

  it("refuses impossible weight sets", () => {
    expect(() => allocateCents(BigInt(10), [])).toThrow(InvalidAllocationMathError);
    expect(() => allocateCents(BigInt(10), [ZERO, ZERO])).toThrow(
      InvalidAllocationMathError,
    );
    expect(() => allocateCents(BigInt(10), [ONE, BigInt(-1)])).toThrow(
      InvalidAllocationMathError,
    );
  });
});

describe("splitEvenly", () => {
  it("splits equal parts and gives the earliest ones the extra cent", () => {
    expect(splitEvenly(BigInt(100), 3)).toEqual([
      BigInt(34),
      BigInt(33),
      BigInt(33),
    ]);
    expect(sum(splitEvenly(BigInt(-7), 3))).toBe(BigInt(-7));
  });

  it("refuses a non-positive number of parts", () => {
    expect(() => splitEvenly(BigInt(1), 0)).toThrow(InvalidAllocationMathError);
    expect(() => splitEvenly(BigInt(1), 1.5)).toThrow(InvalidAllocationMathError);
  });
});

describe("allocation conservation", () => {
  it("derives the unallocated remainder from the identity", () => {
    expect(summarizeAllocation(BigInt(10_000), BigInt(9_999))).toEqual({
      totalCents: BigInt(10_000),
      allocatedCents: BigInt(9_999),
      unallocatedCents: ONE,
    });
  });

  it("accepts full, partial and zero allocation of a positive entry", () => {
    expect(
      assertAllocationConservation(BigInt(10_000), BigInt(10_000)),
    ).toMatchObject({ unallocatedCents: ZERO });
    expect(
      assertAllocationConservation(BigInt(10_000), BigInt(4_000)),
    ).toMatchObject({ unallocatedCents: BigInt(6_000) });
    expect(
      assertAllocationConservation(BigInt(10_000), ZERO),
    ).toMatchObject({ unallocatedCents: BigInt(10_000) });
  });

  it("accepts full, partial and zero allocation of a credit", () => {
    expect(
      assertAllocationConservation(BigInt(-10_000), BigInt(-6_000)),
    ).toMatchObject({ unallocatedCents: BigInt(-4_000) });
    expect(
      assertAllocationConservation(BigInt(-10_000), ZERO),
    ).toMatchObject({ unallocatedCents: BigInt(-10_000) });
  });

  it("refuses over-allocation and a sign mismatch", () => {
    expect(() =>
      assertAllocationConservation(BigInt(10_000), BigInt(10_001)),
    ).toThrow(InvalidAllocationMathError);
    expect(() =>
      assertAllocationConservation(BigInt(10_000), BigInt(-1)),
    ).toThrow(InvalidAllocationMathError);
    expect(() =>
      assertAllocationConservation(BigInt(-10_000), ONE),
    ).toThrow(InvalidAllocationMathError);
  });

  it("refuses a mixed-sign allocation even when the sum looks valid", () => {
    expect(() =>
      assertAllocationSigns(BigInt(-10_000), [
        BigInt(-6_000),
        BigInt(-6_000),
        BigInt(2_000),
      ]),
    ).toThrow(InvalidAllocationMathError);

    expect(() =>
      assertAllocationSigns(BigInt(10_000), [BigInt(4_000), ZERO]),
    ).not.toThrow();
  });
});
