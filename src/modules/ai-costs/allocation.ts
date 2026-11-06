import Decimal from "decimal.js";
import { AMOUNT_DECIMALS } from "@/lib/money";

/**
 * Exact split arithmetic for the cost ledger (M9-02).
 *
 * A split must conserve every cent: `allocated + unallocated === total`, exactly.
 * The split therefore works on integer cents (`bigint`), never on floats. When
 * weights do not divide the total evenly, the remainder is distributed by the
 * **largest remainder** method: each part gets the floor of its exact share, then
 * the leftover cents go one by one to the parts with the largest fractional
 * remainder. Ties go to the earliest part, so the result is deterministic.
 */

export class InvalidAllocationMathError extends Error {
  constructor(reason: string) {
    super(`Invalid allocation arithmetic: ${reason}`);
    this.name = "InvalidAllocationMathError";
  }
}

export const MAX_ALLOCATION_PARTS = 1000;

const ZERO = BigInt(0);
const ONE = BigInt(1);
const HUNDRED = BigInt(100);

function toDecimal(value: Decimal.Value): Decimal {
  if (value === null || value === undefined) {
    throw new InvalidAllocationMathError("an amount is required");
  }

  let decimal: Decimal;
  try {
    decimal = value instanceof Decimal ? value : new Decimal(value);
  } catch {
    throw new InvalidAllocationMathError("amount is not a valid decimal");
  }

  if (!decimal.isFinite()) {
    throw new InvalidAllocationMathError("amount must be finite");
  }

  return decimal;
}

/**
 * Converts an exact two-decimal amount to integer cents.
 *
 * More precision is rejected rather than rounded: the caller must round once at
 * the boundary (`roundToCents`) before splitting, so a split can never lose a
 * fraction silently.
 */
export function toCents(value: Decimal.Value): bigint {
  const decimal = toDecimal(value);

  if (decimal.decimalPlaces() > AMOUNT_DECIMALS) {
    throw new InvalidAllocationMathError(
      `expected at most ${AMOUNT_DECIMALS} decimals before converting to cents`,
    );
  }

  if (decimal.abs().gte("1e16")) {
    throw new InvalidAllocationMathError("amount is out of range");
  }

  return BigInt(decimal.times(HUNDRED.toString()).toFixed(0));
}

/** Converts integer cents back to an exact decimal amount. */
export function fromCents(cents: bigint): Decimal {
  return new Decimal(cents.toString()).dividedBy(HUNDRED.toString());
}

function absolute(value: bigint): bigint {
  return value < ZERO ? -value : value;
}

/**
 * Splits a total in cents across positive weights.
 *
 * Returns one integer-cent share per weight, in the input order. The shares sum
 * to `totalCents` exactly, including for a negative total (a credit): the sign is
 * applied after splitting the absolute value.
 */
export function allocateCents(
  totalCents: bigint,
  weights: readonly bigint[],
): bigint[] {
  if (weights.length === 0) {
    throw new InvalidAllocationMathError("at least one weight is required");
  }

  if (weights.length > MAX_ALLOCATION_PARTS) {
    throw new InvalidAllocationMathError(
      `at most ${MAX_ALLOCATION_PARTS} parts are supported`,
    );
  }

  let totalWeight = ZERO;

  for (const weight of weights) {
    if (weight < ZERO) {
      throw new InvalidAllocationMathError("weights must not be negative");
    }

    totalWeight += weight;
  }

  if (totalWeight === ZERO) {
    throw new InvalidAllocationMathError("at least one weight must be positive");
  }

  const negative = totalCents < ZERO;
  const absoluteTotal = absolute(totalCents);
  const shares: bigint[] = [];
  const remainders: bigint[] = [];
  let allocated = ZERO;

  for (const weight of weights) {
    const numerator = absoluteTotal * weight;
    const share = numerator / totalWeight;
    shares.push(share);
    remainders.push(numerator % totalWeight);
    allocated += share;
  }

  let leftover = absoluteTotal - allocated;

  if (leftover < ZERO || leftover >= BigInt(weights.length)) {
    throw new InvalidAllocationMathError("largest remainder produced an invalid leftover");
  }

  const order = weights
    .map((_, index) => index)
    .sort((left, right) => {
      const difference = remainders[right] - remainders[left];
      return difference === ZERO ? left - right : difference > ZERO ? 1 : -1;
    });

  for (let index = 0; leftover > ZERO; index += 1) {
    shares[order[index]] += ONE;
    leftover -= ONE;
  }

  return negative ? shares.map((share) => -share) : shares;
}

/** Splits a total equally; the earliest parts receive the leftover cents. */
export function splitEvenly(totalCents: bigint, parts: number): bigint[] {
  if (!Number.isInteger(parts) || parts < 1) {
    throw new InvalidAllocationMathError("parts must be a positive integer");
  }

  return allocateCents(
    totalCents,
    Array.from({ length: parts }, () => ONE),
  );
}

export type AllocationSummary = {
  readonly totalCents: bigint;
  readonly allocatedCents: bigint;
  readonly unallocatedCents: bigint;
};

/** The arithmetic identity, regardless of whether the amounts are valid. */
export function summarizeAllocation(
  totalCents: bigint,
  allocatedCents: bigint,
): AllocationSummary {
  return {
    totalCents,
    allocatedCents,
    unallocatedCents: totalCents - allocatedCents,
  };
}

/**
 * Asserts that allocations stay between zero and the entry total, with the
 * entry's sign. The returned summary always satisfies
 * `allocatedCents + unallocatedCents === totalCents`.
 */
export function assertAllocationConservation(
  totalCents: bigint,
  allocatedCents: bigint,
): AllocationSummary {
  const summary = summarizeAllocation(totalCents, allocatedCents);
  const sameSign =
    allocatedCents === ZERO || (allocatedCents < ZERO) === (totalCents < ZERO);
  const withinTotal = absolute(allocatedCents) <= absolute(totalCents);

  if (!sameSign || !withinTotal) {
    throw new InvalidAllocationMathError(
      "allocations must stay between zero and the entry total, with the entry's sign",
    );
  }

  return summary;
}

/**
 * Checks each allocation, not only their sum: a positive allocation on a credit
 * (or the reverse) must be refused even when another row would cancel it.
 */
export function assertAllocationSigns(
  totalCents: bigint,
  allocatedCents: readonly bigint[],
): void {
  for (const cents of allocatedCents) {
    if (cents !== ZERO && (cents < ZERO) !== (totalCents < ZERO)) {
      throw new InvalidAllocationMathError(
        "each allocation must carry the entry's sign",
      );
    }
  }
}
