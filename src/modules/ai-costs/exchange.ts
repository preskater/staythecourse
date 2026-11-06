import Decimal from "decimal.js";
import { parseDateOnly, toDateOnlyString } from "@/lib/dates";
import { assertCurrency, type Currency, type Money } from "@/lib/money";
import type { CostAmount } from "./amount";
import { costMoney, toExactDecimal } from "./money";
import {
  createCostSource,
  type CostSourceInput,
  type CostSourceReference,
} from "./source";

/**
 * Exchange-rate snapshots (M9-04).
 *
 * A provider bills in USD while the workspace keeps its books in EUR. Normalising
 * that amount needs a rate, and a rate that is not frozen turns a figure computed
 * yesterday into a different figure tomorrow. So a rate is stored as a **snapshot**:
 * which pair it describes, the calendar day it is in force for, the exact rate, and
 * where it came from. A converted amount keeps the snapshot it used, and recording a
 * newer rate never rewrites an existing conversion.
 *
 * Nothing here fetches a rate from a live feed and nothing guesses one: a conversion
 * without a snapshot stays **unknown**, never zero and never the original amount.
 *
 * `baseCurrency`/`quoteCurrency` read "1 base is worth `rate` quote". The reverse
 * pair is recorded explicitly rather than derived: an exact inverse is a repeating
 * decimal, and inventing one would hide which figure was actually observed.
 */

/** A rate keeps ten decimals: enough for any quoted pair, and still exact. */
export const RATE_DECIMALS = 10;

export type ExchangeRateInput = {
  baseCurrency: string;
  quoteCurrency: string;
  /** Exact rate; at most `RATE_DECIMALS` decimals, always strictly positive. */
  rate: Decimal.Value;
  /** Calendar day the rate is in force for: `YYYY-MM-DD`, or a `Date` read in UTC. */
  rateDate: Date | string;
  source: CostSourceInput | CostSourceReference;
  /** Instant the snapshot was written. Defaults to now; always stored in UTC. */
  recordedAt?: Date | string;
};

/** An immutable rate description, before it is given an identifier. */
export type ExchangeRate = {
  readonly baseCurrency: Currency;
  readonly quoteCurrency: Currency;
  readonly rate: Decimal;
  /** Calendar day (`YYYY-MM-DD`), distinct from `recordedAt`. */
  readonly rateDate: string;
  readonly source: CostSourceReference;
  /** ISO-8601 instant in UTC. */
  readonly recordedAt: string;
};

/**
 * A stored rate, with the identifier a converted amount references.
 *
 * The identifier is what makes history safe: a conversion points at one snapshot,
 * so a later rate cannot change a figure that was already computed.
 */
export type ExchangeRateSnapshot = ExchangeRate & { readonly id: string };

export class InvalidExchangeRateError extends Error {
  constructor(readonly field: string, reason: string) {
    super(`Invalid exchange rate ${field}: ${reason}`);
    this.name = "InvalidExchangeRateError";
  }
}

/**
 * Converting with a snapshot taken for another pair is a bug, not a missing rate.
 *
 * It throws instead of falling back to an identity or an inverse: a wrong rate would
 * produce a plausible amount, which is worse than a loud failure.
 */
export class ExchangeRatePairMismatchError extends Error {
  constructor(reason: string) {
    super(`Exchange rate pair mismatch: ${reason}`);
    this.name = "ExchangeRatePairMismatchError";
  }
}

const SNAPSHOT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const ISO_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

function toCurrency(field: string, value: unknown): Currency {
  if (typeof value !== "string") {
    throw new InvalidExchangeRateError(field, "expected a currency code");
  }

  try {
    return assertCurrency(value);
  } catch {
    throw new InvalidExchangeRateError(field, `unsupported currency "${value}"`);
  }
}

/** Validates the two currencies of a rate and refuses an identity pair. */
export function assertExchangeRatePair(
  baseCurrency: unknown,
  quoteCurrency: unknown,
): { baseCurrency: Currency; quoteCurrency: Currency } {
  const base = toCurrency("baseCurrency", baseCurrency);
  const quote = toCurrency("quoteCurrency", quoteCurrency);

  if (base === quote) {
    throw new InvalidExchangeRateError(
      "quoteCurrency",
      "must differ from baseCurrency",
    );
  }

  return { baseCurrency: base, quoteCurrency: quote };
}

/** Validates a rate calendar day and returns it as `YYYY-MM-DD`. */
export function parseRateDate(value: unknown): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new InvalidExchangeRateError("rateDate", "expected a valid date");
    }

    return toDateOnlyString(value);
  }

  if (typeof value !== "string") {
    throw new InvalidExchangeRateError(
      "rateDate",
      "expected a calendar day in the YYYY-MM-DD format",
    );
  }

  try {
    parseDateOnly(value);
  } catch {
    throw new InvalidExchangeRateError(
      "rateDate",
      "expected a calendar day in the YYYY-MM-DD format",
    );
  }

  return value;
}

function toRate(value: unknown): Decimal {
  if (value === null || value === undefined) {
    throw new InvalidExchangeRateError("rate", "a rate is required");
  }

  let rate: Decimal;
  try {
    rate = toExactDecimal(value as Decimal.Value);
  } catch {
    throw new InvalidExchangeRateError("rate", "expected a decimal number");
  }

  // `isPositive()` is true for zero in decimal.js: compare instead.
  if (!rate.gt(0)) {
    throw new InvalidExchangeRateError(
      "rate",
      "expected a strictly positive number",
    );
  }

  if (rate.decimalPlaces() > RATE_DECIMALS) {
    throw new InvalidExchangeRateError(
      "rate",
      `expected at most ${RATE_DECIMALS} decimals`,
    );
  }

  return rate;
}

function toRecordedAt(value: Date | string | undefined): string {
  if (value === undefined) {
    return new Date().toISOString();
  }

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new InvalidExchangeRateError("recordedAt", "expected a valid instant");
    }

    return value.toISOString();
  }

  if (typeof value !== "string" || !ISO_INSTANT_PATTERN.test(value)) {
    throw new InvalidExchangeRateError(
      "recordedAt",
      "expected an ISO-8601 instant with an explicit time zone",
    );
  }

  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    throw new InvalidExchangeRateError("recordedAt", "expected a valid instant");
  }

  return parsed.toISOString();
}

function toSnapshotId(value: unknown): string {
  if (typeof value !== "string" || !SNAPSHOT_ID_PATTERN.test(value)) {
    throw new InvalidExchangeRateError("id", "expected an identifier");
  }

  return value;
}

/**
 * Builds a frozen rate description.
 *
 * The source goes through `createCostSource`, so a hand-written object cannot smuggle
 * a token into the snapshot. The rate is exact: more than `RATE_DECIMALS` decimals is
 * an error, never a silent rounding — only the converted amount is rounded, half-up to
 * the cent, by `costMoney` (M9-01).
 */
export function createExchangeRate(input: ExchangeRateInput): ExchangeRate {
  const { baseCurrency, quoteCurrency } = assertExchangeRatePair(
    (input as { baseCurrency?: unknown } | null | undefined)?.baseCurrency,
    (input as { quoteCurrency?: unknown } | null | undefined)?.quoteCurrency,
  );

  return Object.freeze({
    baseCurrency,
    quoteCurrency,
    rate: toRate((input as { rate?: unknown }).rate),
    rateDate: parseRateDate((input as { rateDate?: unknown }).rateDate),
    source: createCostSource((input as { source: CostSourceInput }).source),
    recordedAt: toRecordedAt((input as { recordedAt?: Date | string }).recordedAt),
  });
}

/** Adds the stored identifier to a rate description. */
export function createExchangeRateSnapshot(
  input: ExchangeRateInput & { id: string },
): ExchangeRateSnapshot {
  return Object.freeze({
    id: toSnapshotId((input as { id?: unknown }).id),
    ...createExchangeRate(input),
  });
}

/** One amount converted with one snapshot. */
export type ConvertedMoney = {
  readonly original: Money;
  readonly converted: Money;
  /** Identifier of the snapshot behind `converted`; recomputing it needs this row. */
  readonly snapshotId: string;
};

/**
 * The result of normalising a cost amount.
 *
 * `unknown` is a state of its own: a missing amount and a missing rate are both
 * reported as such, so an interface can say "taux inconnu" instead of showing zero.
 * The original amount and currency are never replaced by the converted figure.
 */
export type Conversion =
  | {
      readonly status: "converted";
      readonly original: Money;
      readonly converted: Money;
      readonly snapshot: ExchangeRateSnapshot;
    }
  | {
      readonly status: "unknown";
      readonly original: Money | null;
      readonly targetCurrency: Currency;
      readonly reason: "missing_amount" | "missing_rate";
    };

/**
 * Converts one amount with one snapshot.
 *
 * The product is rounded **half-up to the cent** exactly once, by `costMoney`, which
 * is the rounding rule of the whole cost ledger. The original is kept as it was given.
 */
export function convertMoney(
  original: Money,
  snapshot: ExchangeRateSnapshot,
): ConvertedMoney {
  if (original.currency !== snapshot.baseCurrency) {
    throw new ExchangeRatePairMismatchError(
      `rate ${snapshot.baseCurrency}/${snapshot.quoteCurrency} cannot convert ${original.currency}.`,
    );
  }

  return Object.freeze({
    original,
    converted: costMoney(
      original.amount.times(snapshot.rate),
      snapshot.quoteCurrency,
    ),
    snapshotId: snapshot.id,
  });
}

export type ConversionOptions = {
  /** Currency the normalised figure must be expressed in. */
  to: Currency;
  /** Snapshot resolved for this conversion; `null` when no rate is recorded. */
  rate: ExchangeRateSnapshot | null;
};

/**
 * Normalises a cost amount into the target currency, or reports why it cannot.
 *
 * A missing amount is reported before a missing rate: an unknown figure stays unknown
 * whatever the rates are. When a snapshot is given and does not describe the requested
 * pair, the call throws — that is a programming error, not an unknown state.
 */
export function convertCostAmount(
  amount: CostAmount,
  options: ConversionOptions,
): Conversion {
  if (amount.money === null) {
    return Object.freeze({
      status: "unknown" as const,
      original: null,
      targetCurrency: options.to,
      reason: "missing_amount" as const,
    });
  }

  if (options.rate === null) {
    return Object.freeze({
      status: "unknown" as const,
      original: amount.money,
      targetCurrency: options.to,
      reason: "missing_rate" as const,
    });
  }

  if (options.rate.quoteCurrency !== options.to) {
    throw new ExchangeRatePairMismatchError(
      `rate ${options.rate.baseCurrency}/${options.rate.quoteCurrency} does not produce ${options.to}.`,
    );
  }

  const converted = convertMoney(amount.money, options.rate);

  return Object.freeze({
    status: "converted" as const,
    original: converted.original,
    converted: converted.converted,
    snapshot: options.rate,
  });
}
