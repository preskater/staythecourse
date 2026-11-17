import Decimal from "decimal.js";
import {
  AMOUNT_DECIMALS,
  assertCurrency,
  type Currency,
  type Money,
} from "@/lib/money";

/**
 * Exact money for the cost ledger.
 *
 * Provider exports often carry more precision than a bill: the raw value stays
 * a `Decimal`, and the only rounding performed here is the documented one —
 * half-up to the cent (`ROUND_HALF_UP`, ties away from zero). The original
 * currency is always kept; this module never converts.
 */

export class InvalidCostMoneyError extends Error {
  constructor(reason: string) {
    super(`Invalid cost money: ${reason}`);
    this.name = "InvalidCostMoneyError";
  }
}

const DECIMAL_STRING_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * Parses an exact decimal without rounding anything.
 *
 * Shared by the cost ledger's money and its exchange rates, which have different
 * precisions: the caller decides how many decimals it accepts and which error to
 * raise, so a value is never silently rounded on the way in.
 */
export function toExactDecimal(value: Decimal.Value): Decimal {
  if (value === null || value === undefined) {
    throw new InvalidCostMoneyError("an amount is required");
  }

  let source: Decimal.Value = value;

  if (typeof source === "string") {
    const trimmed = source.trim();

    if (!DECIMAL_STRING_PATTERN.test(trimmed)) {
      throw new InvalidCostMoneyError("amount is not a decimal number");
    }

    source = trimmed;
  }

  let decimal: Decimal;
  try {
    decimal = source instanceof Decimal ? source : new Decimal(source);
  } catch {
    throw new InvalidCostMoneyError("amount is not a valid decimal");
  }

  if (!decimal.isFinite()) {
    throw new InvalidCostMoneyError("amount must be finite");
  }

  return decimal;
}

/**
 * Rounds a raw value to whole cents, half-up.
 *
 * `1.005` becomes `1.01`, `1.004` becomes `1.00`, and `-1.005` becomes `-1.01`
 * (ties go away from zero). Applied once, at the boundary where a provider or
 * an import produces the amount.
 */
export function roundToCents(value: Decimal.Value): Decimal {
  return toExactDecimal(value).toDecimalPlaces(
    AMOUNT_DECIMALS,
    Decimal.ROUND_HALF_UP,
  );
}

/** Builds a frozen, exact amount in the requested currency. */
export function costMoney(
  amount: Decimal.Value,
  currency: string,
): Money {
  let code: Currency;
  try {
    code = assertCurrency(currency);
  } catch {
    throw new InvalidCostMoneyError(`unsupported currency "${currency}"`);
  }

  return Object.freeze({
    amount: roundToCents(amount),
    currency: code,
  });
}
