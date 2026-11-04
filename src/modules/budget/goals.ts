import Decimal from "decimal.js";
import { z } from "zod";
import { toDateOnlyString } from "@/lib/dates";
import { toDecimalString, type Currency } from "@/lib/money";
import {
  amount,
  currencyCode,
  optionalAmount,
  optionalId,
  optionalText,
  requiredDate,
} from "@/lib/validation";

/**
 * Savings and repayment goals (BP-04).
 *
 * A goal is a target amount in one currency, to be reached by a target date. Its current
 * amount comes from one of two sources: the **recorded balance** of a linked account (the
 * signed sum of its transactions — money transferred in counts, transferred out counts
 * against), or a **manual amount** — a starting amount, to which the logged contributions
 * (see `GoalContribution`) add up. A contribution never touches an account balance; it is
 * a dated log entry saying "this much was set aside that day". With neither a manual
 * amount nor a contribution, or with a linked account that has no recorded transaction,
 * the progress is **unknown** and is displayed as unknown, never as zero: the app only
 * knows what was recorded, and "nothing recorded" is not "nothing saved".
 *
 * Conventions, also documented in `docs/architecture/overview.md`:
 *
 * - **percentage** = current ÷ target × 100, rounded half-up to one decimal. A
 *   non-positive current reads 0 % — the overdraft is told by the amount, not by a
 *   negative percentage.
 * - **months left** = whole calendar months between the current month and the target
 *   month, computed in UTC. The target month itself counts as zero: the deadline falls
 *   this month.
 * - **monthly contribution** = remaining ÷ months, rounded half-up on cents. When the
 *   deadline falls this month, it is the whole remaining amount; once the target date
 *   has passed, or once the goal is reached, it is not defined and the reason is stated
 *   instead of a figure.
 */

export const GOAL_STATUSES = ["ACTIVE", "ACHIEVED", "ABANDONED"] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

export const GOAL_STATUS_LABELS: Record<GoalStatus, string> = {
  ACTIVE: "En cours",
  ACHIEVED: "Atteint",
  ABANDONED: "Abandonné",
};

export type GoalRecord = {
  id: string;
  name: string;
  /** Target amount, always positive. */
  targetAmount: Decimal;
  currency: Currency;
  /** Calendar day at UTC midnight, like every date-only value. */
  targetDate: Date;
  status: GoalStatus;
  /** Manual current amount; mutually exclusive with `accountId`. */
  currentAmount: Decimal | null;
  accountId: string | null;
  accountName: string | null;
};

/** One dated amount set aside (or repaid) for a goal. */
export type GoalContributionRecord = {
  id: string;
  goalId: string;
  /** Positive magnitude, in the goal's currency. */
  amount: Decimal;
  /** Calendar day at UTC midnight, like every date-only value. */
  date: Date;
  note: string | null;
};

export type GoalProgress =
  | {
      kind: "UNKNOWN";
      /** User-facing (French): why nothing can be shown — and that it is not zero. */
      reason: string;
    }
  | {
      kind: "KNOWN";
      current: Decimal;
      /** target − current; negative when the goal is exceeded. */
      remaining: Decimal;
      /** 0–100+ decimal percentage, one decimal, half-up. */
      percentage: Decimal;
      reached: boolean;
      /** Whole calendar months until the target month; 0 when it is current or past. */
      monthsLeft: number;
      /** Null when the goal is reached or the deadline has passed. */
      monthlyContribution: Decimal | null;
      /** Why there is no monthly figure; null when there is one. */
      contributionNote: string | null;
    };

/** Whole calendar months between two instants, computed in UTC; never negative. */
function monthsUntil(now: Date, target: Date): number {
  const months =
    target.getUTCFullYear() * 12 +
    target.getUTCMonth() -
    (now.getUTCFullYear() * 12 + now.getUTCMonth());

  return Math.max(0, months);
}

/**
 * The progress of one goal, from the goal itself, the (optional) balance of its linked
 * account, and the (optional) sum of its contributions.
 *
 * `accountBalance` is `null` when the linked account has nothing recorded — the one case
 * that must not be rendered as a zero balance. `contributionSum` is `null` when the goal
 * has no logged contribution; a manual goal's current amount is its starting amount plus
 * that sum, so logging "500 € set aside" moves the progress by 500 € without touching any
 * account. `now` is injectable so the deadline rules are testable without freezing the
 * clock.
 */
export function computeGoalProgress(
  goal: Pick<GoalRecord, "targetAmount" | "targetDate" | "currentAmount" | "accountId">,
  accountBalance: Decimal | null,
  options: { now?: Date; contributionSum?: Decimal | null } = {},
): GoalProgress {
  const now = options.now ?? new Date();
  const contributionSum = options.contributionSum ?? null;

  // 1. Where the current amount comes from — or the honest statement that it is unknown.
  let current: Decimal;
  if (goal.accountId !== null) {
    if (accountBalance === null) {
      return {
        kind: "UNKNOWN",
        reason:
          "Aucune opération enregistrée sur le compte lié : la progression est inconnue, pas zéro.",
      };
    }
    current = accountBalance;
  } else if (goal.currentAmount !== null || contributionSum !== null) {
    current = (goal.currentAmount ?? new Decimal(0)).plus(contributionSum ?? 0);
  } else {
    return {
      kind: "UNKNOWN",
      reason: "Aucun montant actuel ni compte lié : la progression est inconnue, pas zéro.",
    };
  }

  // 2. Progress, with the documented rounding.
  const remaining = goal.targetAmount.minus(current);
  const reached = remaining.lessThanOrEqualTo(0);
  const percentage = current.lessThanOrEqualTo(0)
    ? new Decimal(0)
    : current.dividedBy(goal.targetAmount).times(100).toDecimalPlaces(1, Decimal.ROUND_HALF_UP);

  const monthsLeft = monthsUntil(now, goal.targetDate);
  const todayUTC = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const deadlinePassed = goal.targetDate.getTime() < todayUTC;

  // 3. What the deadline demands — guarded: no division by zero, no figure once the
  //    deadline has passed, and nothing to plan once the goal is reached.
  let monthlyContribution: Decimal | null = null;
  let contributionNote: string | null = null;

  if (reached) {
    contributionNote = "Objectif atteint : plus rien à planifier.";
  } else if (deadlinePassed) {
    contributionNote = "Échéance passée : la contribution mensuelle n'est plus définie.";
  } else if (monthsLeft === 0) {
    // The deadline falls this month: the whole remaining amount is this month's target.
    monthlyContribution = remaining.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  } else {
    monthlyContribution = remaining.dividedBy(monthsLeft).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  }

  return {
    kind: "KNOWN",
    current,
    remaining,
    percentage,
    reached,
    monthsLeft,
    monthlyContribution,
    contributionNote,
  };
}

/**
 * Footer totals of the goals table, grouped by currency.
 *
 * A total is only ever added inside one currency — the dashboard never converts. The
 * global percentage is a **weighted** ratio, `Σcurrent ÷ Σtarget`, not the average of the
 * per-goal percentages: averaging would let a 5 € goal weigh as much as a 5 000 € one. It
 * follows the per-goal rule (non-positive current reads 0 %, one decimal, half-up).
 *
 * **Shared accounts are counted once.** Several goals may point at the same linked
 * account; that account is one pot of money, so its balance enters `current` (and thus
 * `remaining`) a single time, while every target is still added: the group's target is the
 * sum of what the goals ask for, its current amount is the money actually set aside. The
 * targets are never deduplicated — two goals on one account are two distinct projects to
 * fund.
 *
 * Unknowns are not zeros: as soon as one goal of the group has an unknown progress, the
 * amounts are still summed for the known rows but `complete` turns false and the
 * percentage is `null`, so the caller shows "—" instead of a rounder-looking figure.
 * Likewise `monthlyContribution` is `null` when one goal's contribution is undefined (its
 * deadline has passed) — a reached goal counts as 0, since it asks for nothing. That
 * column stays the **sum of the rows' own figures**, each answering "what does this goal
 * ask for per month from its own source"; it is a plan per goal, not money to add to the
 * linked account once per goal.
 */
export type GoalTotals = {
  currency: Currency;
  goalCount: number;
  /** Σ of the rows' target amounts — never deduplicated. */
  target: Decimal;
  /** Σ of the distinct sources: a linked account shared by several goals counts once. */
  current: Decimal;
  /** Σtarget − Σcurrent (shared accounts included once); negative when exceeded. */
  remaining: Decimal;
  /** Σcurrent ÷ Σtarget × 100, one decimal; `null` when a progress is unknown. */
  percentage: Decimal | null;
  /** Σ of the monthly contributions still required; `null` when one is undefined. */
  monthlyContribution: Decimal | null;
  /** Earliest target date of the group: the closest deadline. */
  nextDeadline: Date;
  /** False when at least one goal of the group has an unknown progress. */
  complete: boolean;
  /** True when at least two goals of the group draw on the same linked account. */
  sharedAccount: boolean;
};

export function summariseGoalTotals(
  rows: readonly { goal: GoalRecord; progress: GoalProgress }[],
): Map<Currency, GoalTotals> {
  const totals = new Map<Currency, GoalTotals>();
  // Per currency, the linked accounts whose balance has already entered `current`: the
  // same account may back several goals, and its money must not be counted twice.
  const countedAccounts = new Map<Currency, Set<string>>();

  for (const { goal, progress } of rows) {
    const total = totals.get(goal.currency) ?? {
      currency: goal.currency,
      goalCount: 0,
      target: new Decimal(0),
      current: new Decimal(0),
      remaining: new Decimal(0),
      percentage: null,
      monthlyContribution: new Decimal(0),
      nextDeadline: goal.targetDate,
      complete: true,
      sharedAccount: false,
    };

    total.goalCount += 1;
    total.target = total.target.plus(goal.targetAmount);
    if (goal.targetDate.getTime() < total.nextDeadline.getTime()) {
      total.nextDeadline = goal.targetDate;
    }

    if (progress.kind === "UNKNOWN") {
      total.complete = false;
    } else {
      const counted = countedAccounts.get(goal.currency) ?? new Set<string>();
      countedAccounts.set(goal.currency, counted);
      const sharedWithCountedGoal = goal.accountId !== null && counted.has(goal.accountId);
      if (goal.accountId !== null) {
        counted.add(goal.accountId);
      }

      if (sharedWithCountedGoal) {
        // The row still shows the account's balance as its own backing; the group only
        // adds that money once, so the whole target of the duplicating goal stays to fund.
        total.sharedAccount = true;
        total.remaining = total.remaining.plus(goal.targetAmount);
      } else {
        total.current = total.current.plus(progress.current);
        total.remaining = total.remaining.plus(progress.remaining);
      }

      if (progress.monthlyContribution === null) {
        // Nothing left to plan for a reached goal; an undefined figure (deadline passed)
        // makes the group's total undefined rather than silently ignored.
        if (!progress.reached) {
          total.monthlyContribution = null;
        }
      } else if (total.monthlyContribution !== null) {
        total.monthlyContribution = total.monthlyContribution.plus(
          progress.monthlyContribution,
        );
      }
    }

    totals.set(goal.currency, total);
  }

  for (const total of totals.values()) {
    if (!total.complete || !total.target.greaterThan(0)) {
      // An unknown goal would leave both the ratio and the monthly plan understated;
      // "—" is the only honest answer for the group.
      total.monthlyContribution = null;
      continue;
    }

    total.percentage = total.current.lessThanOrEqualTo(0)
      ? new Decimal(0)
      : total.current
          .dividedBy(total.target)
          .times(100)
          .toDecimalPlaces(1, Decimal.ROUND_HALF_UP);
  }

  return totals;
}

/** Input contract shared by the creation and the edition of a goal. */
const goalBaseSchema = z.object({
  name: z.string().trim().min(1, "Le nom de l'objectif est requis.").max(120),
  targetAmount: amount.refine(
    (value) => value.greaterThan(0),
    "Le montant cible doit être supérieur à zéro.",
  ),
  currency: currencyCode,
  targetDate: requiredDate,
  status: z.enum(GOAL_STATUSES),
  currentAmount: optionalAmount,
  accountId: optionalId,
});

/** One source of truth at most: a manual amount, or a linked account. */
function exclusiveCurrentSource(value: {
  currentAmount: Decimal | null;
  accountId: string | null;
}): boolean {
  return !(value.currentAmount !== null && value.accountId !== null);
}

const EXCLUSIVE_SOURCE = {
  message: "Choisissez un montant actuel OU un compte lié, pas les deux.",
  path: ["accountId"],
};

/** A manual amount never goes backwards: progress is measured forward. */
function nonNegativeCurrentAmount(value: { currentAmount: Decimal | null }): boolean {
  return value.currentAmount === null || !value.currentAmount.lessThan(0);
}

const NON_NEGATIVE_AMOUNT = {
  message: "Le montant actuel ne peut pas être négatif.",
  path: ["currentAmount"],
};

export const goalInputSchema = goalBaseSchema
  .refine(exclusiveCurrentSource, EXCLUSIVE_SOURCE)
  .refine(nonNegativeCurrentAmount, NON_NEGATIVE_AMOUNT);

export type GoalInput = z.input<typeof goalInputSchema>;
export type ValidatedGoalInput = z.output<typeof goalInputSchema>;

/** The creation fields plus the identifier of the row being edited. */
export const goalUpdateSchema = goalBaseSchema
  .extend({ id: z.string().trim().min(1, "Identifiant manquant.") })
  .refine(exclusiveCurrentSource, EXCLUSIVE_SOURCE)
  .refine(nonNegativeCurrentAmount, NON_NEGATIVE_AMOUNT);

export type GoalUpdateValues = z.input<typeof goalUpdateSchema>;
export type ValidatedGoalUpdate = z.output<typeof goalUpdateSchema>;

/**
 * A goal prepared for the form — strings only, like every other form contract: a
 * `Decimal` or a `Date` cannot cross the server/client boundary.
 */
export type GoalFormInitialValues = {
  id: string;
  name: string;
  targetAmount: string;
  currency: Currency;
  targetDate: string;
  status: GoalStatus;
  /** Empty string when the goal has no manual amount. */
  currentAmount: string;
  /** Empty string when the goal is not linked to an account. */
  accountId: string;
};

export function toGoalFormInitialValues(record: GoalRecord): GoalFormInitialValues {
  return {
    id: record.id,
    name: record.name,
    targetAmount: toDecimalString(record.targetAmount),
    currency: record.currency,
    targetDate: toDateOnlyString(record.targetDate),
    status: record.status,
    currentAmount: record.currentAmount === null ? "" : toDecimalString(record.currentAmount),
    accountId: record.accountId ?? "",
  };
}

/**
 * Input contract for a goal contribution.
 *
 * Contributions belong to manual goals: a goal linked to an account reads that
 * account's balance, and adding contributions on top would count the same money twice.
 * The action enforces that rule against the stored row; the schema only carries the
 * fields.
 */
export const goalContributionInputSchema = z.object({
  goalId: z.string().trim().min(1, "Objectif manquant."),
  amount: amount.refine(
    (value) => value.greaterThan(0),
    "Une contribution doit être supérieure à zéro : elle raconte ce qui a été mis de côté.",
  ),
  date: requiredDate,
  note: optionalText(2000, "Les notes sont limitées à 2000 caractères."),
});

export type GoalContributionInput = z.input<typeof goalContributionInputSchema>;
export type ValidatedGoalContributionInput = z.output<typeof goalContributionInputSchema>;

/** Shared by the action and the UI when a contribution targets a linked goal. */
export const GOAL_CONTRIBUTION_LINKED_MESSAGE =
  "Cet objectif est lié à un compte : sa progression lit le solde du compte, et les contributions sont réservées aux objectifs à montant manuel.";
