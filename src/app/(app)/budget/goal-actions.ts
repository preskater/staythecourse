"use server";

import { revalidatePath } from "next/cache";
import {
  invalidResult,
  rejectedResult,
  unexpectedResult,
  type ActionResult,
} from "@/lib/actions";
import { requireModule } from "@/lib/auth/guard";
import { recordIdInput } from "@/lib/validation";
import {
  GOAL_CONTRIBUTION_LINKED_MESSAGE,
  goalContributionInputSchema,
  goalInputSchema,
  goalUpdateSchema,
  type GoalStatus,
  type ValidatedGoalInput,
} from "@/modules/budget/goals";
import type { Currency } from "@/lib/money";
import type Decimal from "decimal.js";
import {
  createGoal,
  createGoalContribution,
  deleteGoal,
  deleteGoalContribution,
  findAccount,
  findGoal,
  updateGoal,
} from "@/modules/budget/repository";

/**
 * Write Server Actions for financial goals (BP-04).
 *
 * A goal stores either a manual amount or a link to one of the owner's accounts — never
 * both, never another owner's. The account is looked up with the session, and the action
 * refuses a currency mismatch instead of converting: a goal is an amount in one explicit
 * currency, so a linked account must speak the same one.
 */

type ResolvedGoalInput = {
  name: string;
  targetAmount: Decimal;
  currency: Currency;
  targetDate: Date;
  status: GoalStatus;
  currentAmount: Decimal | null;
  accountId: string | null;
};

/**
 * Resolves the optional account of a goal, owning it and matching its currency.
 *
 * A refusal states the account's currency so the fix is obvious ("choose an account in
 * the goal's currency") — the app never converts between currencies.
 */
async function resolveGoalInput(
  workspaceId: string,
  input: ValidatedGoalInput,
): Promise<{ ok: true; input: ResolvedGoalInput } | { ok: false; result: ActionResult }> {
  if (input.accountId === null) {
    return { ok: true, input: { ...input, accountId: null } };
  }

  const account = await findAccount(workspaceId, input.accountId);
  if (!account) {
    return { ok: false, result: rejectedResult("accountId", "Compte introuvable.") };
  }

  if (account.currency !== input.currency) {
    return {
      ok: false,
      result: rejectedResult(
        "accountId",
        `Le compte est en ${account.currency} : choisissez un compte dans la devise de l'objectif (aucune conversion n'est faite).`,
      ),
    };
  }

  return { ok: true, input: { ...input, accountId: account.id } };
}

/** Creates one goal. Whatever it does not link to, it records as "no account". */
export async function createGoalAction(values: unknown): Promise<ActionResult> {
  const user = await requireModule("budget", "write");

  const parsed = goalInputSchema.safeParse(values);
  if (!parsed.success) {
    return invalidResult(parsed.error);
  }

  try {
    const resolved = await resolveGoalInput(user.workspace.id, parsed.data);
    if (!resolved.ok) {
      return resolved.result;
    }

    await createGoal({ workspaceId: user.workspace.id, ...resolved.input });
  } catch (error) {
    return unexpectedResult("createGoal", error);
  }

  revalidatePath("/budget");
  return { status: "ok" };
}

/** Replaces the editable fields of one goal. */
export async function updateGoalAction(values: unknown): Promise<ActionResult> {
  const user = await requireModule("budget", "write");

  const parsed = goalUpdateSchema.safeParse(values);
  if (!parsed.success) {
    return invalidResult(parsed.error);
  }

  const { id, ...fields } = parsed.data;

  try {
    const resolved = await resolveGoalInput(user.workspace.id, fields);
    if (!resolved.ok) {
      return resolved.result;
    }

    const updated = await updateGoal(user.workspace.id, id, resolved.input);
    if (!updated) {
      return rejectedResult("id", "Objectif introuvable : il a peut-être été supprimé entre-temps.");
    }
  } catch (error) {
    return unexpectedResult("updateGoal", error);
  }

  revalidatePath("/budget");
  return { status: "ok" };
}

/** Removes one goal. The two-step confirmation lives in the client component. */
export async function deleteGoalAction(values: unknown): Promise<ActionResult> {
  const user = await requireModule("budget", "write");

  const parsed = recordIdInput.safeParse(values);
  if (!parsed.success) {
    return invalidResult(parsed.error);
  }

  try {
    const deleted = await deleteGoal(user.workspace.id, parsed.data.id);
    if (!deleted) {
      return rejectedResult("id", "Objectif introuvable : il a peut-être déjà été supprimé.");
    }
  } catch (error) {
    return unexpectedResult("deleteGoal", error);
  }

  revalidatePath("/budget");
  return { status: "ok" };
}

/**
 * Logs one contribution onto a manual goal.
 *
 * Contributions belong to manual goals: a goal linked to an account reads that
 * account's balance, and adding contributions on top would count the same money twice —
 * the action refuses with that reason. The contribution never touches the ledger: it is
 * a dated log entry that adds to the goal's starting amount, so the progress moves by
 * exactly what was logged.
 */
export async function addGoalContributionAction(values: unknown): Promise<ActionResult> {
  const user = await requireModule("budget", "write");

  const parsed = goalContributionInputSchema.safeParse(values);
  if (!parsed.success) {
    return invalidResult(parsed.error);
  }

  try {
    const goal = await findGoal(user.workspace.id, parsed.data.goalId);
    if (!goal) {
      return rejectedResult("goalId", "Objectif introuvable : il a peut-être été supprimé entre-temps.");
    }

    if (goal.accountId !== null) {
      return rejectedResult("goalId", GOAL_CONTRIBUTION_LINKED_MESSAGE);
    }

    await createGoalContribution({
      workspaceId: user.workspace.id,
      goalId: goal.id,
      amount: parsed.data.amount,
      date: parsed.data.date,
      note: parsed.data.note,
    });
  } catch (error) {
    return unexpectedResult("addGoalContribution", error);
  }

  revalidatePath("/budget");
  return { status: "ok" };
}

/** Removes one logged contribution; the goal's progress moves back accordingly. */
export async function deleteGoalContributionAction(values: unknown): Promise<ActionResult> {
  const user = await requireModule("budget", "write");

  const parsed = recordIdInput.safeParse(values);
  if (!parsed.success) {
    return invalidResult(parsed.error);
  }

  try {
    const deleted = await deleteGoalContribution(user.workspace.id, parsed.data.id);
    if (!deleted) {
      return rejectedResult("id", "Contribution introuvable : elle a peut-être déjà été supprimée.");
    }
  } catch (error) {
    return unexpectedResult("deleteGoalContribution", error);
  }

  revalidatePath("/budget");
  return { status: "ok" };
}
