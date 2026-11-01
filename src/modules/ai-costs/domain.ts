/**
 * Shared primitives of the canonical cost ledger (M9-01).
 *
 * An amount without an actuality or a source is a guess: this module makes both
 * mandatory, keeps unknown values distinguishable from zero, and freezes the
 * source's capture instant so it cannot be rewritten later.
 *
 * Exchange rates (M9-04) follow the same rule: a conversion keeps the exact snapshot
 * it used, so recording a newer rate never rewrites a figure already computed, and a
 * missing rate stays unknown.
 */
export * from "./actuality";
export * from "./amount";
export * from "./exchange";
export * from "./money";
export * from "./source";
