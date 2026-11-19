import Decimal from "decimal.js";
import {
  allocateCents,
  assertAllocationConservation,
  assertAllocationSigns,
  MAX_ALLOCATION_PARTS,
  toCents,
} from "./allocation";
import {
  hasCostDimension,
  normalizeCostDimensions,
  type CostDimensions,
  type CostDimensionsInput,
} from "./dimensions";
import { toExactDecimal } from "./money";

/**
 * Allocation policies (M9-03): pure functions, no I/O, no clock.
 *
 * A policy version is an immutable list of targets (dimension sets). Applying it to
 * an amount in cents yields one integer-cent share per target through the ledger's
 * largest-remainder split (`allocateCents`), so the same inputs always produce the
 * same allocations and every cent is conserved.
 *
 * What each kind reads as the weight of a target:
 * - `MANUAL`: the measure *is* the amount (two decimals, the entry's sign). Their sum
 *   may stay below the amount; the rest stays unallocated.
 * - `EQUAL_SEAT`: a whole number of seats; every seat costs the same.
 * - `USAGE_WEIGHTED`: a non-negative usage figure (tokens, minutes…), up to six decimals.
 * - `REVENUE_WEIGHTED`: the target project's net invoiced revenue over the entry period
 *   (see `revenueMeasures`).
 * - `FIXED_PERCENTAGE`: a percentage stored on the version (two decimals, total ≤ 100).
 *   Below 100, the missing share stays unallocated instead of being spread.
 *
 * When no target carries any weight (no seat, no usage, no revenue), the split is
 * refused rather than guessed.
 */

export const ALLOCATION_POLICY_KINDS = [
  "MANUAL",
  "EQUAL_SEAT",
  "USAGE_WEIGHTED",
  "REVENUE_WEIGHTED",
  "FIXED_PERCENTAGE",
] as const;
export type AllocationPolicyKind = (typeof ALLOCATION_POLICY_KINDS)[number];

export const MAX_POLICY_TARGETS = 100;
export const MAX_POLICY_NAME_LENGTH = 120;
export const MAX_POLICY_RATIONALE_LENGTH = 2000;
/** Precision accepted for usage and revenue weights. */
export const POLICY_MEASURE_DECIMALS = 6;

const PERCENT_DECIMALS = 2;
const BASIS_POINTS_TOTAL = BigInt(10000);
const MEASURE_SCALE = new Decimal(10).pow(POLICY_MEASURE_DECIMALS);
const ZERO = BigInt(0);
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

export class InvalidAllocationPolicyError extends Error {
  constructor(
    readonly field: string,
    reason: string,
  ) {
    super(`Invalid allocation policy ${field}: ${reason}`);
    this.name = "InvalidAllocationPolicyError";
  }
}

export type PolicyTargetInput = {
  dimensions: CostDimensionsInput;
  /** Required for `FIXED_PERCENTAGE`, refused otherwise. */
  percent?: Decimal.Value | null;
};

export type PolicyTarget = {
  readonly dimensions: CostDimensions;
  /** Exact percentage as a string (`"12.50"`), or null outside `FIXED_PERCENTAGE`. */
  readonly percent: string | null;
};

export type PlannedAllocation = {
  readonly dimensions: CostDimensions;
  readonly amountCents: bigint;
  /** The weight the policy read for this target, kept on the allocation to explain it. */
  readonly measure: Decimal;
};

export function isAllocationPolicyKind(value: unknown): value is AllocationPolicyKind {
  return (
    typeof value === "string" &&
    (ALLOCATION_POLICY_KINDS as readonly string[]).includes(value)
  );
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") {
    throw new InvalidAllocationPolicyError(field, "expected text");
  }

  const trimmed = value.trim();

  if (trimmed.length === 0) {
    throw new InvalidAllocationPolicyError(field, "is required");
  }

  if (trimmed.length > max) {
    throw new InvalidAllocationPolicyError(field, `at most ${max} characters`);
  }

  if (CONTROL_CHARACTERS.test(trimmed)) {
    throw new InvalidAllocationPolicyError(field, "contains control characters");
  }

  return trimmed;
}

export function validatePolicyName(value: unknown): string {
  return text(value, "name", MAX_POLICY_NAME_LENGTH);
}

export function validatePolicyKind(value: unknown): AllocationPolicyKind {
  if (!isAllocationPolicyKind(value)) {
    throw new InvalidAllocationPolicyError("kind", "unknown policy kind");
  }

  return value;
}

function decimalOf(value: Decimal.Value, field: string): Decimal {
  try {
    return toExactDecimal(value);
  } catch {
    throw new InvalidAllocationPolicyError(field, "expected a decimal number");
  }
}

function percentOf(value: unknown, field: string): Decimal {
  if (value === null || value === undefined) {
    throw new InvalidAllocationPolicyError(field, "a percentage is required");
  }

  const percent = decimalOf(value as Decimal.Value, field);

  if (percent.decimalPlaces() > PERCENT_DECIMALS) {
    throw new InvalidAllocationPolicyError(field, `at most ${PERCENT_DECIMALS} decimals`);
  }

  if (percent.lte(0) || percent.gt(100)) {
    throw new InvalidAllocationPolicyError(field, "must be above 0 and at most 100");
  }

  return percent;
}

/**
 * Validates a version's targets for a kind. Also used to read stored versions back,
 * so a malformed row fails loudly instead of producing a split.
 */
export function validatePolicyTargets(
  kind: AllocationPolicyKind,
  input: unknown,
): PolicyTarget[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new InvalidAllocationPolicyError("targets", "at least one target is required");
  }

  if (input.length > MAX_POLICY_TARGETS) {
    throw new InvalidAllocationPolicyError(
      "targets",
      `at most ${MAX_POLICY_TARGETS} targets`,
    );
  }

  const seen = new Set<string>();
  let percentTotal = new Decimal(0);

  const targets = input.map((raw, index): PolicyTarget => {
    const field = `targets[${index}]`;

    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new InvalidAllocationPolicyError(field, "expected an object");
    }

    const target = raw as Record<string, unknown>;
    const dimensions = normalizeCostDimensions(
      target.dimensions as CostDimensionsInput | null | undefined,
    );

    if (!hasCostDimension(dimensions)) {
      throw new InvalidAllocationPolicyError(field, "a target needs at least one dimension");
    }

    if (kind === "REVENUE_WEIGHTED" && dimensions.projectId === null) {
      throw new InvalidAllocationPolicyError(
        field,
        "revenue weighting needs a project on every target",
      );
    }

    const key = JSON.stringify(dimensions);

    if (seen.has(key)) {
      throw new InvalidAllocationPolicyError(field, "duplicate target");
    }

    seen.add(key);

    if (kind !== "FIXED_PERCENTAGE") {
      if (target.percent !== undefined && target.percent !== null) {
        throw new InvalidAllocationPolicyError(field, "only fixed-percentage targets take a percentage");
      }

      return Object.freeze({ dimensions, percent: null });
    }

    const percent = percentOf(target.percent, `${field}.percent`);
    percentTotal = percentTotal.plus(percent);

    return Object.freeze({ dimensions, percent: percent.toFixed(PERCENT_DECIMALS) });
  });

  if (percentTotal.gt(100)) {
    throw new InvalidAllocationPolicyError("targets", "percentages add up to more than 100");
  }

  return targets;
}

export function validatePolicyRationale(value: unknown): string {
  return text(value, "rationale", MAX_POLICY_RATIONALE_LENGTH);
}

function measuresFor(
  kind: AllocationPolicyKind,
  targets: readonly PolicyTarget[],
  measures: readonly Decimal.Value[] | null | undefined,
): Decimal[] {
  if (kind === "FIXED_PERCENTAGE") {
    if (measures !== null && measures !== undefined) {
      throw new InvalidAllocationPolicyError("measures", "a fixed-percentage policy takes no measure");
    }

    return targets.map((target) => new Decimal(target.percent ?? "0"));
  }

  if (!Array.isArray(measures) || measures.length !== targets.length) {
    throw new InvalidAllocationPolicyError("measures", "expected one measure per target");
  }

  return measures.map((value, index) => {
    const field = `measures[${index}]`;
    const measure = decimalOf(value, field);

    if (kind === "MANUAL") {
      if (measure.decimalPlaces() > 2) {
        throw new InvalidAllocationPolicyError(field, "an amount has at most 2 decimals");
      }

      return measure;
    }

    if (measure.isNegative()) {
      throw new InvalidAllocationPolicyError(field, "must not be negative");
    }

    if (kind === "EQUAL_SEAT" && !measure.isInteger()) {
      throw new InvalidAllocationPolicyError(field, "seats are whole numbers");
    }

    if (measure.decimalPlaces() > POLICY_MEASURE_DECIMALS) {
      throw new InvalidAllocationPolicyError(
        field,
        `at most ${POLICY_MEASURE_DECIMALS} decimals`,
      );
    }

    return measure;
  });
}

function sharesFor(
  kind: AllocationPolicyKind,
  totalCents: bigint,
  measures: readonly Decimal[],
): bigint[] {
  if (kind === "MANUAL") {
    const shares = measures.map((measure) => toCents(measure));
    assertAllocationSigns(totalCents, shares);
    assertAllocationConservation(
      totalCents,
      shares.reduce((sum, cents) => sum + cents, ZERO),
    );
    return shares;
  }

  if (kind === "FIXED_PERCENTAGE") {
    const basisPoints = measures.map((percent) => BigInt(percent.times(100).toFixed(0)));
    const assigned = basisPoints.reduce((sum, points) => sum + points, ZERO);
    // The trailing residual slot keeps the share below 100 % unallocated.
    return allocateCents(totalCents, [...basisPoints, BASIS_POINTS_TOTAL - assigned]).slice(
      0,
      measures.length,
    );
  }

  const weights = measures.map((measure) => BigInt(measure.times(MEASURE_SCALE).toFixed(0)));

  if (weights.every((weight) => weight === ZERO)) {
    throw new InvalidAllocationPolicyError(
      "measures",
      "no target has any weight: nothing can be split",
    );
  }

  return allocateCents(totalCents, weights);
}

/**
 * Splits `totalCents` (usually an entry's unallocated remainder) across a version's
 * targets. Targets whose share rounds to zero produce no allocation.
 */
export function planPolicyAllocations(
  kind: AllocationPolicyKind,
  targets: readonly PolicyTarget[],
  totalCents: bigint,
  measures?: readonly Decimal.Value[] | null,
): PlannedAllocation[] {
  if (totalCents === ZERO) {
    throw new InvalidAllocationPolicyError("amount", "nothing left to allocate");
  }

  if (targets.length === 0 || targets.length > Math.min(MAX_POLICY_TARGETS, MAX_ALLOCATION_PARTS)) {
    throw new InvalidAllocationPolicyError("targets", "invalid target count");
  }

  const read = measuresFor(kind, targets, measures);
  const shares = sharesFor(kind, totalCents, read);

  return targets
    .map((target, index) => ({
      dimensions: target.dimensions,
      amountCents: shares[index],
      measure: read[index],
    }))
    .filter((planned) => planned.amountCents !== ZERO);
}

export type RevenueDocumentFigure = {
  projectId: string;
  kind: "INVOICE" | "CREDIT_NOTE";
  currency: string;
  /** Positive magnitude, as stored on `RevenueDocument`. */
  amount: Decimal.Value;
  /** `YYYY-MM-DD`. */
  issuedOn: string;
};

/**
 * Revenue weight of each target for `REVENUE_WEIGHTED`.
 *
 * Definition: invoices minus credit notes of the target's project, issued between
 * `periodStart` and `periodEnd` inclusive, in the entry's currency. Payments do not
 * matter (invoiced, not cashed). A document of another currency in the window is
 * refused, never converted silently; a negative net is refused by the split.
 */
export function revenueMeasures(
  targets: readonly PolicyTarget[],
  documents: readonly RevenueDocumentFigure[],
  window: { currency: string; periodStart: string; periodEnd: string },
): Decimal[] {
  const totals = new Map<string, Decimal>();
  const projects = new Set(targets.map((target) => target.dimensions.projectId));

  for (const document of documents) {
    if (
      !projects.has(document.projectId) ||
      document.issuedOn < window.periodStart ||
      document.issuedOn > window.periodEnd
    ) {
      continue;
    }

    if (document.currency !== window.currency) {
      throw new InvalidAllocationPolicyError(
        "revenue",
        `revenue in ${document.currency} cannot weight a ${window.currency} cost`,
      );
    }

    const amount = decimalOf(document.amount, "revenue");
    const signed = document.kind === "CREDIT_NOTE" ? amount.negated() : amount;
    totals.set(
      document.projectId,
      (totals.get(document.projectId) ?? new Decimal(0)).plus(signed),
    );
  }

  return targets.map(
    (target) => totals.get(target.dimensions.projectId ?? "") ?? new Decimal(0),
  );
}
