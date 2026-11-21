import Decimal from "decimal.js";

/**
 * Reconciliation of imported provider cost lines against the provider's own total
 * for the same window (M11-02).
 *
 * Tolerance: **0.01 per currency for the whole window**. Providers such as OpenAI send
 * each line as a JSON float; summing many of them drifts by far less than a cent, so
 * a larger gap means lines are missing or duplicated, not rounding. The tolerance is
 * absolute rather than relative so a large month cannot hide a missing line.
 *
 * A currency present on one side only is compared against zero: a total with no
 * imported line is exactly the gap this check exists to reveal.
 */

export const RECONCILIATION_TOLERANCE = new Decimal("0.01");

export type ReconciliationStatus = "RECONCILED" | "MISMATCH" | "INCOMPLETE";

export type CurrencyReconciliation = {
  currency: string;
  /** Exact decimal strings, so the result can be shown and stored without floats. */
  imported: string;
  provider: string;
  /** `imported - provider`. */
  difference: string;
  withinTolerance: boolean;
};

export type ReconciliationResult = {
  /** `INCOMPLETE` when either side was not fully read: the figures are not comparable. */
  status: ReconciliationStatus;
  currencies: CurrencyReconciliation[];
};

export function reconcileTotals(input: {
  imported: ReadonlyMap<string, Decimal>;
  provider: ReadonlyMap<string, Decimal>;
  /** Both sides fully read for the same window. */
  complete: boolean;
}): ReconciliationResult {
  const codes = [...new Set([...input.imported.keys(), ...input.provider.keys()])].sort();

  const currencies = codes.map((currency) => {
    const imported = input.imported.get(currency) ?? new Decimal(0);
    const provider = input.provider.get(currency) ?? new Decimal(0);
    const difference = imported.minus(provider);

    return {
      currency,
      imported: imported.toFixed(),
      provider: provider.toFixed(),
      difference: difference.toFixed(),
      withinTolerance: difference.abs().lte(RECONCILIATION_TOLERANCE),
    };
  });

  const status: ReconciliationStatus = !input.complete
    ? "INCOMPLETE"
    : currencies.every((row) => row.withinTolerance)
      ? "RECONCILED"
      : "MISMATCH";

  return { status, currencies };
}
