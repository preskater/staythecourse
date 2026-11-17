import Decimal from "decimal.js";
import { parseDateOnly, toDateOnlyString } from "@/lib/dates";
import { costMoney } from "./money";
import { assertActuality, ACTUALITIES, type Actuality } from "./actuality";
import {
  hasCostDimension,
  normalizeCostDimensions,
  type CostDimensions,
  type CostDimensionsInput,
} from "./dimensions";
import {
  createCostSource,
  type CostSourceInput,
  type CostSourceReference,
} from "./source";
import type { Money } from "@/lib/money";

/**
 * A canonical cost entry and its allocations (M9-02).
 *
 * An entry records **what was spent** — amount, currency, actuality, source and
 * billing period — and the allocations record **who consumed it**. The sum of the
 * allocations can never exceed the entry total; the difference is the unallocated
 * remainder, which is derived and never stored, so it cannot drift from the rows.
 *
 * Once an entry is finalized, neither it nor its allocations can change. A
 * correction is a new entry: the ledger keeps the history it already published.
 */

export const COST_ENTRY_STATUSES = ["DRAFT", "FINALIZED"] as const;
export type CostEntryStatus = (typeof COST_ENTRY_STATUSES)[number];

export type CostEntryInput = {
  /** Signed, exact amount: negative is a credit or a refund. */
  amount: Decimal.Value;
  currency: string;
  actuality: Actuality | string;
  source: CostSourceInput | CostSourceReference;
  /** First calendar day covered, inclusive (`YYYY-MM-DD` or a UTC `Date`). */
  periodStart: Date | string;
  /** Last calendar day covered, inclusive (`YYYY-MM-DD` or a UTC `Date`). */
  periodEnd: Date | string;
  notes?: string | null;
  /** Where the cost is known to belong, before any split. */
  dimensions?: CostDimensionsInput | null;
};

export type CostEntry = {
  readonly id: string;
  readonly amount: Money;
  readonly actuality: Actuality;
  readonly source: CostSourceReference;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly notes: string | null;
  readonly dimensions: CostDimensions;
  readonly status: CostEntryStatus;
  readonly finalizedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

export type CostAllocationInput = {
  entryId: string;
  amount: Decimal.Value;
  /** At least one dimension: an allocation with no target is not an allocation. */
  dimensions: CostDimensionsInput;
};

export type CostAllocationUpdateInput = {
  amount: Decimal.Value;
  dimensions: CostDimensionsInput;
};

export type CostAllocation = {
  readonly id: string;
  readonly entryId: string;
  readonly amount: Money;
  readonly dimensions: CostDimensions;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

export type CostEntryTotals = {
  readonly total: Money;
  readonly allocated: Money;
  readonly unallocated: Money;
};

export type CostEntryLedger = {
  readonly entry: CostEntry;
  readonly allocations: readonly CostAllocation[];
  readonly totals: CostEntryTotals;
};

export type ValidatedCostEntry = {
  readonly amount: Money;
  readonly actuality: Actuality;
  readonly source: CostSourceReference;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly notes: string | null;
  readonly dimensions: CostDimensions;
};

export type ValidatedCostAllocationShape = {
  readonly entryId: string;
  readonly amount: Decimal;
  readonly dimensions: CostDimensions;
};

export type ValidatedCostAllocationUpdateShape = {
  readonly amount: Decimal;
  readonly dimensions: CostDimensions;
};

export type ValidatedCostAllocation = {
  readonly entryId: string;
  readonly amount: Money;
  readonly dimensions: CostDimensions;
};

export const MAX_COST_NOTES_LENGTH = 2000;

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

export class InvalidCostEntryError extends Error {
  constructor(
    readonly field: string,
    reason: string,
  ) {
    super(`Invalid cost entry ${field}: ${reason}`);
    this.name = "InvalidCostEntryError";
  }
}

export class InvalidCostAllocationError extends Error {
  constructor(
    readonly field: string,
    reason: string,
  ) {
    super(`Invalid cost allocation ${field}: ${reason}`);
    this.name = "InvalidCostAllocationError";
  }
}

/**
 * A finalized entry is history. The message deliberately carries no identifier
 * and no amount: it may reach a log, and the ledger does not belong there.
 */
export class FinalizedCostEntryError extends Error {
  constructor() {
    super("This cost entry is finalized; corrections require a new entry.");
    this.name = "FinalizedCostEntryError";
  }
}

export class CostEntryNotFoundError extends Error {
  constructor() {
    super("Cost entry not found in this workspace.");
    this.name = "CostEntryNotFoundError";
  }
}

function toObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidCostEntryError("input", "expected an object");
  }

  return value as Record<string, unknown>;
}

function toDecimalAmount(value: unknown, field: string, ErrorType: typeof InvalidCostEntryError | typeof InvalidCostAllocationError): Decimal {
  if (value === null || value === undefined) {
    throw new ErrorType(field, "an amount is required");
  }

  let decimal: Decimal;
  try {
    decimal = value instanceof Decimal ? value : new Decimal(value as Decimal.Value);
  } catch {
    throw new ErrorType(field, "expected a decimal number");
  }

  if (!decimal.isFinite()) {
    throw new ErrorType(field, "expected a finite number");
  }

  return decimal;
}

function toCalendarDay(
  value: unknown,
  field: string,
  ErrorType: typeof InvalidCostEntryError,
): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new ErrorType(field, "expected a valid date");
    }

    return toDateOnlyString(value);
  }

  if (typeof value !== "string") {
    throw new ErrorType(field, "expected a calendar day in the YYYY-MM-DD format");
  }

  try {
    parseDateOnly(value);
  } catch {
    throw new ErrorType(field, "expected a calendar day in the YYYY-MM-DD format");
  }

  return value;
}

function toNotes(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value !== "string") {
    throw new InvalidCostEntryError("notes", "expected a string or null");
  }

  const notes = value.replace(/\r\n/g, "\n").trim();

  if (notes.length === 0) {
    return null;
  }

  if (notes.length > MAX_COST_NOTES_LENGTH) {
    throw new InvalidCostEntryError(
      "notes",
      `expected at most ${MAX_COST_NOTES_LENGTH} characters`,
    );
  }

  if (CONTROL_CHARACTERS.test(notes)) {
    throw new InvalidCostEntryError("notes", "control characters are not allowed");
  }

  return notes;
}

function toIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new InvalidCostAllocationError(field, "expected an identifier");
  }

  const identifier = value.trim();

  if (identifier.length === 0 || identifier.length > 128) {
    throw new InvalidCostAllocationError(
      field,
      "expected between 1 and 128 characters",
    );
  }

  return identifier;
}

/** Validates and normalises a cost entry before it reaches the database. */
export function validateCostEntryInput(
  input: CostEntryInput | null | undefined,
): ValidatedCostEntry {
  const source = toObject(input);
  const amount = toDecimalAmount(source.amount, "amount", InvalidCostEntryError);

  if (typeof source.currency !== "string") {
    throw new InvalidCostEntryError("currency", "expected a currency code");
  }

  const money = costMoney(amount, source.currency);

  if (money.amount.isZero()) {
    throw new InvalidCostEntryError("amount", "a cost entry cannot be zero");
  }

  const actuality = assertActuality(source.actuality);
  const sourceReference = createCostSource(source.source as CostSourceInput);
  const periodStart = toCalendarDay(source.periodStart, "periodStart", InvalidCostEntryError);
  const periodEnd = toCalendarDay(source.periodEnd, "periodEnd", InvalidCostEntryError);

  if (periodEnd < periodStart) {
    throw new InvalidCostEntryError(
      "periodEnd",
      "must not be before the period start",
    );
  }

  return {
    amount: money,
    actuality,
    source: sourceReference,
    periodStart,
    periodEnd,
    notes: toNotes(source.notes),
    dimensions: normalizeCostDimensions(source.dimensions as CostDimensionsInput | null | undefined),
  };
}

/** Validates the entry-independent part of an allocation. */
export function validateCostAllocationUpdateShape(
  input: CostAllocationUpdateInput | null | undefined,
): ValidatedCostAllocationUpdateShape {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new InvalidCostAllocationError("input", "expected an object");
  }

  const amount = toDecimalAmount(
    input.amount,
    "amount",
    InvalidCostAllocationError,
  );

  if (amount.isZero()) {
    throw new InvalidCostAllocationError("amount", "an allocation cannot be zero");
  }

  const dimensions = normalizeCostDimensions(input.dimensions);

  if (!hasCostDimension(dimensions)) {
    throw new InvalidCostAllocationError(
      "dimensions",
      "at least one dimension or tag is required",
    );
  }

  return { amount, dimensions };
}

/** Validates a new allocation, including its entry identifier. */
export function validateCostAllocationShape(
  input: CostAllocationInput | null | undefined,
): ValidatedCostAllocationShape {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new InvalidCostAllocationError("input", "expected an object");
  }

  const entryId = toIdentifier(input.entryId, "entryId");
  const shape = validateCostAllocationUpdateShape(input);

  return { entryId, ...shape };
}

/**
 * Completes an allocation with the entry's currency, applying the ledger's single
 * rounding step (half-up to the cent).
 */
export function prepareCostAllocation(
  input: CostAllocationInput | null | undefined,
  currency: string,
): ValidatedCostAllocation {
  const shape = validateCostAllocationShape(input);
  const amount = costMoney(shape.amount, currency);

  if (amount.amount.isZero()) {
    throw new InvalidCostAllocationError("amount", "an allocation cannot be zero");
  }

  return { entryId: shape.entryId, amount, dimensions: shape.dimensions };
}

/** Completes an allocation update with the entry's currency. */
export function prepareCostAllocationUpdate(
  input: CostAllocationUpdateInput | null | undefined,
  currency: string,
): Omit<ValidatedCostAllocation, "entryId"> {
  const shape = validateCostAllocationUpdateShape(input);
  const amount = costMoney(shape.amount, currency);

  if (amount.amount.isZero()) {
    throw new InvalidCostAllocationError("amount", "an allocation cannot be zero");
  }

  return { amount, dimensions: shape.dimensions };
}

/** Refuses any write on a finalized entry. */
export function assertCostEntryEditable(status: CostEntryStatus): void {
  if (status === "FINALIZED") {
    throw new FinalizedCostEntryError();
  }
}

const STORED_ACTUALITY: Record<
  Actuality,
  "OBSERVED" | "DERIVED" | "ALLOCATED" | "ESTIMATED" | "RECONCILED"
> = {
  observed: "OBSERVED",
  derived: "DERIVED",
  allocated: "ALLOCATED",
  estimated: "ESTIMATED",
  reconciled: "RECONCILED",
};

export function toStoredActuality(
  value: Actuality,
): "OBSERVED" | "DERIVED" | "ALLOCATED" | "ESTIMATED" | "RECONCILED" {
  return STORED_ACTUALITY[value];
}

export function fromStoredActuality(value: string): Actuality {
  const actuality = ACTUALITIES.find((candidate) => STORED_ACTUALITY[candidate] === value);

  if (!actuality) {
    throw new Error("Unknown stored cost actuality.");
  }

  return actuality;
}
