import Decimal from "decimal.js";
import { z } from "zod";
import { assertCurrency, formatMoney, money, type Currency } from "@/lib/money";
import type { AlertCandidate, AlertRuleConfig } from "@/modules/alerts/domain";

/**
 * AI budgets and spend alerts (M12-03).
 *
 * A budget caps the monthly spend of one ledger dimension, in one currency. Spend is
 * the same figure as the overview's: the sum of the entries whose period starts in the
 * calendar month, refunds included, never converted. Two alert kinds read it, mirroring
 * the budget module's pair: `AI_BUDGET_THRESHOLD` is the preventive warning below the
 * cap, `AI_BUDGET_OVERRUN` takes over past it, and the threshold episode resolves when
 * it does.
 *
 * A budget with no entry in its scope this month stays quiet: missing data is not a
 * spend of zero. The ledger has no model column, so there is no per-model budget.
 */

/** Dimension codes, each with the ledger column it watches (`null`: the whole workspace). */
export const AI_BUDGET_DIMENSIONS = [
  { code: "workspace", column: null, label: "Tout l'espace" },
  { code: "provider", column: "sourceProvider", label: "Fournisseur" },
  { code: "project", column: "projectId", label: "Projet" },
  { code: "client", column: "clientId", label: "Client" },
  { code: "developer", column: "developerId", label: "Développeur" },
  { code: "agent", column: "agentId", label: "Agent" },
] as const;

export type AiBudgetDimension = (typeof AI_BUDGET_DIMENSIONS)[number]["code"];
export type AiBudgetColumn = NonNullable<(typeof AI_BUDGET_DIMENSIONS)[number]["column"]>;

const DIMENSION_CODES = AI_BUDGET_DIMENSIONS.map(({ code }) => code) as [
  AiBudgetDimension,
  ...AiBudgetDimension[],
];

export function aiBudgetDimension(code: string) {
  return AI_BUDGET_DIMENSIONS.find((dimension) => dimension.code === code) ?? null;
}

/** Upper bound on a workspace's AI budgets: the refresh pass reads them all. */
export const MAX_AI_BUDGETS = 100;

export type AiBudget = {
  id: string;
  dimension: AiBudgetDimension;
  /** `""` for the whole workspace. */
  dimensionValue: string;
  amount: Decimal;
  currency: Currency;
};

/** The spend of one budget's scope this cycle; `entryCount: 0` means "no data". */
export type AiBudgetSpend = { budgetId: string; spent: Decimal; entryCount: number };

/** The form contract, strings only. */
export const aiBudgetInputSchema = z
  .object({
    dimension: z.enum(DIMENSION_CODES, { message: "Dimension inconnue." }),
    dimensionValue: z.string().trim().max(128, "128 caractères au plus."),
    amount: z
      .string()
      .trim()
      .transform((value, ctx) => {
        try {
          const parsed = new Decimal(value.replace(/\s/g, "").replace(",", "."));
          if (parsed.isFinite() && parsed.greaterThan(0) && parsed.decimalPlaces() <= 2) {
            return parsed;
          }
        } catch {
          // Reported below.
        }
        ctx.addIssue({ code: "custom", message: "Montant strictement positif attendu. Exemple : 200,00." });
        return z.NEVER;
      }),
    currency: z.string().transform((value, ctx) => {
      try {
        return assertCurrency(value);
      } catch {
        ctx.addIssue({ code: "custom", message: "Devise non prise en charge." });
        return z.NEVER;
      }
    }),
  })
  .superRefine((value, ctx) => {
    if (value.dimension === "workspace") return;
    if (value.dimensionValue === "") {
      ctx.addIssue({ code: "custom", path: ["dimensionValue"], message: "Valeur requise pour cette dimension." });
    }
  })
  .transform((value) => ({
    ...value,
    // The whole workspace has no value: whatever was typed is not kept.
    dimensionValue: value.dimension === "workspace" ? "" : value.dimensionValue,
  }));

export type AiBudgetFormValues = z.input<typeof aiBudgetInputSchema>;
export type AiBudgetInput = z.output<typeof aiBudgetInputSchema>;

export function describeAiBudgetScope(budget: Pick<AiBudget, "dimension" | "dimensionValue">): string {
  const dimension = aiBudgetDimension(budget.dimension);
  if (!dimension || dimension.code === "workspace") return "Tout l'espace";
  return `${dimension.label} « ${budget.dimensionValue} »`;
}

/** Spent ÷ cap × 100, exact; the display rounds to one decimal. */
export function spendPercent(spent: Decimal, cap: Decimal): Decimal {
  return spent.dividedBy(cap).times(100);
}

export function aiBudgetOverrunFingerprint(budgetId: string, monthKey: string): string {
  return `ai-budget-overrun:${budgetId}:${monthKey}`;
}

export function aiBudgetThresholdFingerprint(budgetId: string, monthKey: string): string {
  return `ai-budget-threshold:${budgetId}:${monthKey}`;
}

function inputsFor(budget: AiBudget, spent: Decimal, monthKey: string) {
  return {
    budgetId: budget.id,
    scope: describeAiBudgetScope(budget),
    currency: budget.currency,
    month: monthKey,
    planned: budget.amount.toFixed(2),
    actual: spent.toFixed(2),
  };
}

type EvaluationOptions = { monthKey: string };

function withSpend(budgets: readonly AiBudget[], spends: readonly AiBudgetSpend[]) {
  const byBudget = new Map(spends.map((spend) => [spend.budgetId, spend]));
  return budgets.flatMap((budget) => {
    const spend = byBudget.get(budget.id);
    // No entry in scope this cycle: quiet, never "0 spent".
    return spend && spend.entryCount > 0 ? [{ budget, spent: spend.spent }] : [];
  });
}

/** Spend past the cap by at least the margin (percent of the cap; 0 = any overrun). */
export function evaluateAiBudgetOverrun(
  budgets: readonly AiBudget[],
  spends: readonly AiBudgetSpend[],
  rule: AlertRuleConfig,
  options: EvaluationOptions,
): AlertCandidate[] {
  if (!rule.enabled) return [];
  const margin = rule.thresholdPercent ?? new Decimal(0);

  return withSpend(budgets, spends).flatMap(({ budget, spent }) => {
    const overrun = spent.minus(budget.amount);
    if (!overrun.greaterThan(0)) return [];

    const overrunPercent = spendPercent(overrun, budget.amount);
    if (overrunPercent.lessThan(margin)) return [];

    return [
      {
        kind: "AI_BUDGET_OVERRUN" as const,
        fingerprint: aiBudgetOverrunFingerprint(budget.id, options.monthKey),
        inputs: {
          ...inputsFor(budget, spent, options.monthKey),
          overrun: overrun.toFixed(2),
          overrunPercent: overrunPercent.toDecimalPlaces(1, Decimal.ROUND_HALF_UP).toFixed(1),
        },
      },
    ];
  });
}

/**
 * The preventive warning: spend has reached the configured share of the cap without
 * exceeding it. At exactly 100 % it still runs; the first cent over resolves it while
 * the overrun alert opens.
 */
export function evaluateAiBudgetThreshold(
  budgets: readonly AiBudget[],
  spends: readonly AiBudgetSpend[],
  rule: AlertRuleConfig,
  options: EvaluationOptions,
): AlertCandidate[] {
  if (!rule.enabled) return [];
  const threshold = rule.thresholdPercent ?? new Decimal(0);

  return withSpend(budgets, spends).flatMap(({ budget, spent }) => {
    if (spent.greaterThan(budget.amount)) return [];

    const percent = spendPercent(spent, budget.amount);
    // Refunds larger than the spend never reach a positive threshold.
    if (percent.lessThan(threshold) || percent.lessThanOrEqualTo(0)) return [];

    return [
      {
        kind: "AI_BUDGET_THRESHOLD" as const,
        fingerprint: aiBudgetThresholdFingerprint(budget.id, options.monthKey),
        inputs: {
          ...inputsFor(budget, spent, options.monthKey),
          percent: percent.toDecimalPlaces(1, Decimal.ROUND_HALF_UP).toFixed(1),
          thresholdPercent: threshold.toString(),
        },
      },
    ];
  });
}

/* ------------------------------------------------------------------------ Page DTO */

export type AiBudgetRowDto = {
  id: string;
  scope: string;
  cap: string;
  spent: string | null;
  percent: string | null;
  /** `null` when there is no data, never a zero. */
  state: "no-data" | "ok" | "threshold" | "overrun";
};

export function toAiBudgetRows(
  budgets: readonly AiBudget[],
  spends: readonly AiBudgetSpend[],
  thresholdPercent: Decimal,
): AiBudgetRowDto[] {
  const byBudget = new Map(spends.map((spend) => [spend.budgetId, spend]));

  return budgets.map((budget) => {
    const base = {
      id: budget.id,
      scope: describeAiBudgetScope(budget),
      cap: formatMoney(money(budget.amount, budget.currency)),
    };
    const spend = byBudget.get(budget.id);
    if (!spend || spend.entryCount === 0) {
      return { ...base, spent: null, percent: null, state: "no-data" as const };
    }

    const percent = spendPercent(spend.spent, budget.amount);
    return {
      ...base,
      spent: formatMoney(money(spend.spent, budget.currency)),
      percent: `${percent.toDecimalPlaces(1, Decimal.ROUND_HALF_UP).toFixed(1).replace(".", ",")} %`,
      state: spend.spent.greaterThan(budget.amount)
        ? ("overrun" as const)
        : percent.greaterThanOrEqualTo(thresholdPercent) && percent.greaterThan(0)
          ? ("threshold" as const)
          : ("ok" as const),
    };
  });
}
