"use server";

import { revalidatePath } from "next/cache";
import {
  invalidResult,
  isUniqueConstraintError,
  rejectedResult,
  unexpectedResult,
  type ActionResult,
} from "@/lib/actions";
import { requireModule } from "@/lib/auth/guard";
import { formatMonthLabel, monthRange, parseMonthKey, shiftMonthKey } from "@/lib/dates";
import { recordIdInput } from "@/lib/validation";
import {
  accountArchiveSchema,
  accountInputSchema,
  accountUpdateSchema,
  budgetCopySchema,
  budgetInputSchema,
  budgetMonthKey,
  budgetUpdateSchema,
  categoryInputSchema,
  categoryMergeSchema,
  categoryUpdateSchema,
  DUPLICATE_BUDGET_MESSAGE,
  reconciliationInputSchema,
  transactionFormSchema,
  transactionUpdateSchema,
  transferInputSchema,
  type CategorySummary,
  type ValidatedBudgetInput,
} from "@/modules/budget/domain";
import {
  copyBudgets,
  countAccountTransactions,
  countCategoryReferences,
  createAccount,
  createBudget,
  createCategory,
  createTransaction,
  createTransferGroup,
  createWorkDay,
  deleteBudget,
  deleteCategory,
  deleteTransaction,
  deleteWorkDay,
  ensureCategory,
  findAccount,
  findBudgetByPeriod,
  findCategory,
  findManagedAccount,
  findSalarySetting,
  findTransaction,
  findTransactionByExternalRef,
  findWorkDay,
  listSalaryRates,
  listWorkDays,
  mergeCategories,
  setAccountArchived,
  setTransactionReconciled,
  updateAccount,
  updateBudget,
  updateCategory,
  updateTransaction,
  updateWorkDay,
  upsertSalaryRate,
  upsertSalarySetting,
} from "@/modules/budget/repository";
import {
  adjustWorkDayHours,
  computeSalarySummary,
  DUPLICATE_SALARY_BOOKING_MESSAGE,
  nextWorkDayState,
  noSalaryRateMessage,
  resolveSalaryRate,
  SALARY_CATEGORY_NAME,
  salaryBookingInputSchema,
  salaryBookingRef,
  salarySettingInputSchema,
  workDayHoursInputSchema,
  workDayInputSchema,
} from "@/modules/budget/salary";
import { resolveTransactionInput } from "@/modules/budget/transactions";
import { defaultTransferLabels, transferLegEditRefusedReason } from "@/modules/budget/transfers";
import { findCashflowLinkedToTransaction } from "@/modules/real-estate/repository";
import { expenseSimulationSchema } from "@/modules/budget/simulation";
import {
  serializeSimulationResult,
  type SerializedSimulationResult,
} from "@/modules/budget/simulation-contract";
import { runExpenseSimulation } from "@/modules/budget/simulation-service";

/**
 * Write Server Actions for the budget module.
 *
 * Authorisation is checked here, on the server, before anything else: a Server
 * Action is a public endpoint. The same zod schema that drives the form validates
 * the payload again, and every identifier it carries is looked up for the
 * signed-in owner, so a replayed request cannot reach another account.
 */

export async function createAccountAction(values: unknown): Promise<ActionResult> {
  const user = await requireModule("budget", "write");

  const parsed = accountInputSchema.safeParse(values);
  if (!parsed.success) {
    return invalidResult(parsed.error);
  }

  try {
    await createAccount({
      workspaceId: user.workspace.id,
      name: parsed.data.name,
      type: parsed.data.type,
      currency: parsed.data.currency,
      lowBalanceThreshold: parsed.data.lowBalanceThreshold,
    });
  } catch (error) {
    return unexpectedResult("createAccount", error);
  }

  revalidatePath("/budget");
  return { status: "ok" };
}

export async function createCategoryAction(values: unknown): Promise<ActionResult> {
  const user = await requireModule("budget", "write");

  const parsed = categoryInputSchema.safeParse(values);
  if (!parsed.success) {
    return invalidResult(parsed.error);
  }

  try {
    await createCategory({
      workspaceId: user.workspace.id,
      name: parsed.data.name,
      kind: parsed.data.kind,
    });
  } catch (error) {
    return unexpectedResult("createCategory", error);
  }

  revalidatePath("/budget");
  return { status: "ok" };
}

export async function createTransactionAction(values: unknown): Promise<ActionResult> {
  const user = await requireModule("budget", "write");

  const parsed = transactionFormSchema.safeParse(values);
  if (!parsed.success) {
    return invalidResult(parsed.error);
  }

  const input = parsed.data;

  const resolved = await resolveTransactionInput(user.workspace.id, input);
  if (!resolved.ok) {
    return resolved.result;
  }

  try {
    await createTransaction({
      workspaceId: user.workspace.id,
      accountId: resolved.account.id,
      categoryId: input.categoryId,
      type: input.type,
      label: input.label,
      amount: input.amount,
      currency: resolved.account.currency,
      operationDate: input.operationDate,
      notes: input.notes,
      // Imports set this to the source identifier of the record; a manual entry
      // has no source, so the uniqueness rule never blocks it.
      externalRef: null,
    });
  } catch (error) {
    return unexpectedResult("createTransaction", error);
  }

  revalidatePath("/budget");
  revalidatePath("/dashboard");
  return { status: "ok" };
}

export type ExpenseSimulationActionResult =
  | { status: "ok"; simulation: SerializedSimulationResult }
  | Extract<ActionResult, { status: "invalid" | "error" }>;

/**
 * A read-only scenario. It goes through the same authorisation and validation as a
 * write, because a Server Action is a public endpoint, but it never revalidates a
 * path: no row changed.
 */
export async function simulateExpenseAction(
  values: unknown,
): Promise<ExpenseSimulationActionResult> {
  const user = await requireModule("budget", "read");
  const parsed = expenseSimulationSchema.safeParse(values);
  if (!parsed.success) {
    return invalidResult(parsed.error) as ExpenseSimulationActionResult;
  }

  try {
    const outcome = await runExpenseSimulation({
      workspaceId: user.workspace.id,
      values: parsed.data,
    });

    if (!outcome.ok) {
      return rejectedResult(
        outcome.field,
        outcome.message,
      ) as ExpenseSimulationActionResult;
    }

    return {
      status: "ok",
      simulation: serializeSimulationResult(outcome.result),
    };
  } catch (error) {
    return unexpectedResult("simulateExpense", error) as ExpenseSimulationActionResult;
  }
}

/**
 * Edits one transaction in place.
 *
 * Same rules as the creation, plus one of its own: the row must still exist and belong
 * to the signed-in owner. Correcting a line matters more than it looks — deleting it and
 * typing it again would drop the link a property cashflow holds on it, and move the date
 * of a correction nobody asked to recreate.
 */
export async function updateTransactionAction(values: unknown): Promise<ActionResult> {
  const user = await requireModule("budget", "write");

  const parsed = transactionUpdateSchema.safeParse(values);
  if (!parsed.success) {
    return invalidResult(parsed.error);
  }

  const input = parsed.data;

  const resolved = await resolveTransactionInput(user.workspace.id, input);
  if (!resolved.ok) {
    return resolved.result;
  }

  try {
    // A leg of a linked transfer is one half of a movement: correcting it alone would
    // let the two halves diverge. The action refuses and names the way out.
    const existing = await findTransaction(user.workspace.id, input.id);
    if (!existing) {
      return rejectedResult(
        "id",
        "Opération introuvable : elle a peut-être été supprimée entre-temps.",
      );
    }

    const grouped = transferLegEditRefusedReason(existing.transferGroupId);
    if (grouped) {
      return rejectedResult("id", grouped);
    }

    const updated = await updateTransaction(user.workspace.id, input.id, {
      accountId: resolved.account.id,
      categoryId: input.categoryId,
      type: input.type,
      label: input.label,
      amount: input.amount,
      currency: resolved.account.currency,
      operationDate: input.operationDate,
      notes: input.notes,
    });

    if (!updated) {
      return rejectedResult(
        "id",
        "Opération introuvable : elle a peut-être été supprimée entre-temps.",
      );
    }
  } catch (error) {
    return unexpectedResult("updateTransaction", error);
  }

  revalidatePath("/budget");
  revalidatePath("/dashboard");
  return { status: "ok" };
}

/**
 * Removes one transaction.
 *
 * A deliberate refusal before a deliberate deletion: a transaction linked to a
 * property cashflow cannot be removed here. The schema would null the link, leaving
 * the cashflow with neither an amount nor a transaction, which is precisely the state
 * `resolveCashflowAmount` throws on — the property page would then fail for a row the
 * owner can no longer see. Naming the property is more useful than a crash later.
 */
export async function deleteTransactionAction(values: unknown): Promise<ActionResult> {
  const user = await requireModule("budget", "write");

  const parsed = recordIdInput.safeParse(values);
  if (!parsed.success) {
    return invalidResult(parsed.error);
  }

  const link = await findCashflowLinkedToTransaction(user.workspace.id, parsed.data.id);
  if (link) {
    return rejectedResult(
      "id",
      `Cette opération est rattachée au flux du bien « ${link.propertyName} ». Supprimez d'abord ce flux dans Immobilier.`,
    );
  }

  let grouped = false;

  try {
    const outcome = await deleteTransaction(user.workspace.id, parsed.data.id);
    if (!outcome.deleted) {
      return rejectedResult("id", "Opération introuvable : elle a peut-être déjà été supprimée.");
    }
    grouped = outcome.grouped;
  } catch (error) {
    return unexpectedResult("deleteTransaction", error);
  }

  revalidatePath("/budget");
  revalidatePath("/dashboard");
  return {
    status: "ok",
    ...(grouped
      ? { message: "Virement supprimé : ses deux mouvements ont été retirés ensemble." }
      : {}),
  };
}

/**
 * Validation shared by the creation and the edition of a budget.
 *
 * Two things must hold before anything is written: the category belongs to the owner,
 * and the (category, month, currency) period is still free. `excludeBudgetId` keeps an
 * edition's own row out of the duplicate check, so correcting only the amount is not a
 * collision with itself.
 *
 * The pre-check is not a race guard: two requests can cross between the read and the
 * write, and the unique index is what refuses the second one. It is there so the
 * ordinary duplicate arrives as a readable field error without a database exception.
 */
async function resolveBudgetInput(
  workspaceId: string,
  input: ValidatedBudgetInput,
  options: { excludeBudgetId?: string } = {},
): Promise<{ ok: true; category: CategorySummary } | { ok: false; result: ActionResult }> {
  const category = await findCategory(workspaceId, input.categoryId);
  if (!category) {
    return { ok: false, result: rejectedResult("categoryId", "Catégorie introuvable.") };
  }

  const duplicate = await findBudgetByPeriod(workspaceId, {
    categoryId: category.id,
    year: input.month.year,
    month: input.month.month,
    currency: input.currency,
  });

  if (duplicate && duplicate.id !== options.excludeBudgetId) {
    return { ok: false, result: rejectedResult("categoryId", DUPLICATE_BUDGET_MESSAGE) };
  }

  return { ok: true, category };
}

export async function createBudgetAction(values: unknown): Promise<ActionResult> {
  const user = await requireModule("budget", "write");

  const parsed = budgetInputSchema.safeParse(values);
  if (!parsed.success) {
    return invalidResult(parsed.error);
  }

  const input = parsed.data;

  const resolved = await resolveBudgetInput(user.workspace.id, input);
  if (!resolved.ok) {
    return resolved.result;
  }

  try {
    await createBudget({
      workspaceId: user.workspace.id,
      categoryId: resolved.category.id,
      year: input.month.year,
      month: input.month.month,
      currency: input.currency,
      amount: input.amount,
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return rejectedResult("categoryId", DUPLICATE_BUDGET_MESSAGE);
    }

    return unexpectedResult("createBudget", error);
  }

  revalidatePath("/budget");
  return { status: "ok" };
}

/** Edits one monthly budget in place; same rules as the creation. */
export async function updateBudgetAction(values: unknown): Promise<ActionResult> {
  const user = await requireModule("budget", "write");

  const parsed = budgetUpdateSchema.safeParse(values);
  if (!parsed.success) {
    return invalidResult(parsed.error);
  }

  const input = parsed.data;

  const resolved = await resolveBudgetInput(user.workspace.id, input, { excludeBudgetId: input.id });
  if (!resolved.ok) {
    return resolved.result;
  }

  try {
    const updated = await updateBudget(user.workspace.id, input.id, {
      categoryId: resolved.category.id,
      year: input.month.year,
      month: input.month.month,
      currency: input.currency,
      amount: input.amount,
    });

    if (!updated) {
      return rejectedResult(
        "id",
        "Budget introuvable : il a peut-être été supprimé entre-temps.",
      );
    }
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return rejectedResult("categoryId", DUPLICATE_BUDGET_MESSAGE);
    }

    return unexpectedResult("updateBudget", error);
  }

  revalidatePath("/budget");
  return { status: "ok" };
}

/** Removes one monthly budget. The two-step confirmation lives in the client component. */
export async function deleteBudgetAction(values: unknown): Promise<ActionResult> {
  const user = await requireModule("budget", "write");

  const parsed = recordIdInput.safeParse(values);
  if (!parsed.success) {
    return invalidResult(parsed.error);
  }

  try {
    const deleted = await deleteBudget(user.workspace.id, parsed.data.id);
    if (!deleted) {
      return rejectedResult("id", "Budget introuvable : il a peut-être déjà été supprimé.");
    }
  } catch (error) {
    return unexpectedResult("deleteBudget", error);
  }

  revalidatePath("/budget");
  return { status: "ok" };
}

/**
 * Saves the simulator: the displayed month's hourly rate, plus the two global options.
 *
 * The rate is a **change point** — it applies from the submitted month on, until the
 * next entry — so a row is only written when the month's resolved rate actually changes:
 * editing the day length must not sprinkle redundant rows. Only the rate is stored; the
 * weekly and monthly figures shown next to it are derived at render time (see
 * `salaryEquivalents`).
 */
export async function saveSalarySettingAction(values: unknown): Promise<ActionResult> {
  const user = await requireModule("budget", "write");

  const parsed = salarySettingInputSchema.safeParse(values);
  if (!parsed.success) {
    return invalidResult(parsed.error);
  }

  const { year, month } = parsed.data.month;

  try {
    const rates = await listSalaryRates(user.workspace.id);
    const current = resolveSalaryRate(rates, year, month);

    if (!current || !current.hourlyRate.equals(parsed.data.hourlyRate)) {
      await upsertSalaryRate({
        workspaceId: user.workspace.id,
        year,
        month,
        hourlyRate: parsed.data.hourlyRate,
      });
    }

    await upsertSalarySetting({
      workspaceId: user.workspace.id,
      hoursPerDay: parsed.data.hoursPerDay,
      currency: parsed.data.currency,
    });
  } catch (error) {
    return unexpectedResult("saveSalarySetting", error);
  }

  revalidatePath("/budget");
  return { status: "ok" };
}

/**
 * One click on the salary calendar.
 *
 * The cycle is the feature: the first click plans the day with the configured day
 * length, the second marks it really worked, the third removes it. The current state is
 * read here rather than accepted from the browser, so a replayed payload cannot skip a
 * level; the unique constraint on (owner, date) keeps a crossed request from creating
 * two rows.
 */
export async function cycleWorkDayAction(values: unknown): Promise<ActionResult> {
  const user = await requireModule("budget", "write");

  const parsed = workDayInputSchema.safeParse(values);
  if (!parsed.success) {
    return invalidResult(parsed.error);
  }

  const date = parsed.data.date;

  try {
    const [setting, current, rates] = await Promise.all([
      findSalarySetting(user.workspace.id),
      findWorkDay(user.workspace.id, date),
      listSalaryRates(user.workspace.id),
    ]);

    if (!setting) {
      return rejectedResult(
        "date",
        "Renseignez d'abord le taux horaire et les heures par jour : ils transforment les jours cliqués en montants.",
      );
    }

    const next = nextWorkDayState(current?.status ?? null);

    if (next === "REMOVE") {
      await deleteWorkDay(user.workspace.id, date);
    } else if (current === null) {
      // Planning a day needs the month's rate: without one, the day could never produce
      // an amount, and the calendar would lead nowhere.
      const monthOfDay = date.getUTCMonth() + 1;
      const rate = resolveSalaryRate(rates, date.getUTCFullYear(), monthOfDay);
      if (!rate) {
        return rejectedResult(
          "date",
          noSalaryRateMessage(date.getUTCFullYear(), monthOfDay),
        );
      }

      await createWorkDay({
        workspaceId: user.workspace.id,
        date,
        status: next,
        // The configured day length is copied onto the day: editing the setting later
        // must not rewrite days that were already planned.
        hours: setting.hoursPerDay,
      });
    } else {
      await updateWorkDay(user.workspace.id, date, { status: next });
    }
  } catch (error) {
    return unexpectedResult("cycleWorkDay", error);
  }

  revalidatePath("/budget");
  return { status: "ok" };
}

/** Half-hour adjustment of one planned or worked day. */
export async function adjustWorkDayHoursAction(values: unknown): Promise<ActionResult> {
  const user = await requireModule("budget", "write");

  const parsed = workDayHoursInputSchema.safeParse(values);
  if (!parsed.success) {
    return invalidResult(parsed.error);
  }

  const { date, direction } = parsed.data;

  try {
    const current = await findWorkDay(user.workspace.id, date);
    if (!current) {
      return rejectedResult("date", "Ce jour n'est plus dans le calendrier : rechargez la page.");
    }

    const nextHours = adjustWorkDayHours(current.hours, direction);
    // At a bound the value does not move: no write, but still a success, so a button
    // that has nothing left to do never looks like an error.
    if (!nextHours.equals(current.hours)) {
      await updateWorkDay(user.workspace.id, date, { hours: nextHours });
    }
  } catch (error) {
    return unexpectedResult("adjustWorkDayHours", error);
  }

  revalidatePath("/budget");
  return { status: "ok" };
}

/**
 * Turns the month's simulated hours into one real income entry.
 *
 * The booking is the only way the simulation writes into the accounts, and it does so on
 * the owner's explicit click: the amount is recomputed here from the month's clicked days
 * — planned and worked, each counted once (never taken from the browser) — the account
 * must be in the salary currency (no conversion), and the « Salaire » category is created
 * if the owner never made one. The Prévisions tab shows the same prévision and calls this
 * same action, so both doors record the same figure. The entry carries a stable import
 * reference (`salary:2026-10`), so the unique constraint makes a second attempt for the
 * same month fail instead of silently doubling the income; the pre-check lets the tabs
 * show the recorded entry instead of the button.
 */
export async function bookSalaryAction(values: unknown): Promise<ActionResult> {
  const user = await requireModule("budget", "write");

  const parsed = salaryBookingInputSchema.safeParse(values);
  if (!parsed.success) {
    return invalidResult(parsed.error);
  }

  const { month, accountId, date } = parsed.data;

  try {
    const [setting, account, rates] = await Promise.all([
      findSalarySetting(user.workspace.id),
      findAccount(user.workspace.id, accountId),
      listSalaryRates(user.workspace.id),
    ]);

    if (!setting) {
      return rejectedResult(
        "accountId",
        "Renseignez d'abord le taux horaire et les heures par jour : ils transforment les heures en montants.",
      );
    }

    const rate = resolveSalaryRate(rates, month.year, month.month);
    if (!rate) {
      return rejectedResult("accountId", noSalaryRateMessage(month.year, month.month));
    }

    if (!account) {
      return rejectedResult("accountId", "Compte introuvable.");
    }

    if (account.currency !== setting.currency) {
      return rejectedResult(
        "accountId",
        `Le salaire est en ${setting.currency} : choisissez un compte dans cette devise, aucune conversion n'est faite.`,
      );
    }

    const reference = salaryBookingRef(month.year, month.month);
    const existing = await findTransactionByExternalRef(user.workspace.id, reference);
    if (existing) {
      return rejectedResult("accountId", DUPLICATE_SALARY_BOOKING_MESSAGE);
    }

    const range = monthRange(month.year, month.month);
    const workDays = await listWorkDays(user.workspace.id, { from: range.start, to: range.end });
    const summary = computeSalarySummary(workDays, rate.hourlyRate);

    if (summary.totalAmount.isZero()) {
      return rejectedResult(
        "date",
        "Aucun jour cliqué sur ce mois : il n'y a rien à enregistrer.",
      );
    }

    const category = await ensureCategory({
      workspaceId: user.workspace.id,
      name: SALARY_CATEGORY_NAME,
      kind: "INCOME",
    });

    await createTransaction({
      workspaceId: user.workspace.id,
      accountId: account.id,
      categoryId: category.id,
      type: "INCOME",
      // Simulated hours × rate (planned + worked, each day once), positive: the sign
      // rule for an income holds.
      label: `Salaire ${formatMonthLabel(month.year, month.month)}`,
      amount: summary.totalAmount,
      currency: account.currency,
      operationDate: date,
      notes: null,
      externalRef: reference,
    });
  } catch (error) {
    // The unique index is the race guard for two clicks crossing between the pre-check
    // and the write; it answers with the same message as the pre-check.
    if (isUniqueConstraintError(error)) {
      return rejectedResult("accountId", DUPLICATE_SALARY_BOOKING_MESSAGE);
    }

    return unexpectedResult("bookSalary", error);
  }

  revalidatePath("/budget");
  revalidatePath("/dashboard");
  return { status: "ok" };
}

/**
 * Renames an account, or moves it between types.
 *
 * The currency may only change while the account holds no transaction: existing rows
 * keep the currency they were written in and the app never converts, so changing it
 * under history would make the account and its own past contradict each other. An
 * archived account can still be renamed — restoring it is a separate tick.
 */
export async function updateAccountAction(values: unknown): Promise<ActionResult> {
  const user = await requireModule("budget", "write");

  const parsed = accountUpdateSchema.safeParse(values);
  if (!parsed.success) {
    return invalidResult(parsed.error);
  }

  const input = parsed.data;

  try {
    const account = await findManagedAccount(user.workspace.id, input.id);
    if (!account) {
      return rejectedResult("id", "Compte introuvable : il a peut-être été supprimé entre-temps.");
    }

    if (input.currency !== account.currency) {
      const transactionCount = await countAccountTransactions(user.workspace.id, account.id);
      if (transactionCount > 0) {
        return rejectedResult(
          "currency",
          `Ce compte porte ${transactionCount} opération${transactionCount > 1 ? "s" : ""} en ${account.currency} : sa devise ne peut plus changer, aucune conversion n'est faite.`,
        );
      }
    }

    const updated = await updateAccount(user.workspace.id, input.id, {
      name: input.name,
      type: input.type,
      currency: input.currency,
      lowBalanceThreshold: input.lowBalanceThreshold,
    });

    if (!updated) {
      return rejectedResult("id", "Compte introuvable : il a peut-être été supprimé entre-temps.");
    }
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return rejectedResult("name", "Un compte porte déjà ce nom.");
    }

    return unexpectedResult("updateAccount", error);
  }

  revalidatePath("/budget");
  return { status: "ok" };
}

/**
 * Archives or restores an account — never a deletion.
 *
 * An archived account disappears from the entry forms and from the alert engine, while
 * its history stays readable and its transactions keep their dates. Restoring only
 * clears the stamp.
 */
export async function setAccountArchivedAction(values: unknown): Promise<ActionResult> {
  const user = await requireModule("budget", "write");

  const parsed = accountArchiveSchema.safeParse(values);
  if (!parsed.success) {
    return invalidResult(parsed.error);
  }

  try {
    const updated = await setAccountArchived(user.workspace.id, parsed.data.id, parsed.data.archived);
    if (!updated) {
      return rejectedResult("id", "Compte introuvable : il a peut-être été supprimé entre-temps.");
    }
  } catch (error) {
    return unexpectedResult("setAccountArchived", error);
  }

  revalidatePath("/budget");
  return {
    status: "ok",
    message: parsed.data.archived
      ? "Compte archivé : il n'apparaît plus dans les formulaires de saisie, son historique reste lisible."
      : "Compte réactivé : il réapparaît dans les formulaires de saisie.",
  };
}

/**
 * Renames a category, or moves it between kinds.
 *
 * The kind may only change while nothing references the category — a transaction, a
 * budget or a recurring series. Its kind is what every report reads to decide which side
 * of the ledger the row lands on; moving it under history would silently re-label the
 * past, so the action refuses and points at merging instead.
 */
export async function updateCategoryAction(values: unknown): Promise<ActionResult> {
  const user = await requireModule("budget", "write");

  const parsed = categoryUpdateSchema.safeParse(values);
  if (!parsed.success) {
    return invalidResult(parsed.error);
  }

  const input = parsed.data;

  try {
    const category = await findCategory(user.workspace.id, input.id);
    if (!category) {
      return rejectedResult("id", "Catégorie introuvable : elle a peut-être été supprimée entre-temps.");
    }

    if (input.kind !== category.kind) {
      const references = await countCategoryReferences(user.workspace.id, category.id);
      const total = references.transactions + references.budgets + references.recurring;

      if (total > 0) {
        return rejectedResult(
          "kind",
          `Cette catégorie est utilisée (${references.transactions} opération${references.transactions > 1 ? "s" : ""}, ${references.budgets} budget${references.budgets > 1 ? "s" : ""}, ${references.recurring} série${references.recurring > 1 ? "s" : ""}) : son type ne peut pas changer sans déplacer son histoire du mauvais côté. Fusionnez-la plutôt vers une catégorie du bon type.`,
        );
      }
    }

    const updated = await updateCategory(user.workspace.id, input.id, {
      name: input.name,
      kind: input.kind,
    });

    if (!updated) {
      return rejectedResult("id", "Catégorie introuvable : elle a peut-être été supprimée entre-temps.");
    }
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return rejectedResult("name", "Une catégorie du même nom et du même type existe déjà.");
    }

    return unexpectedResult("updateCategory", error);
  }

  revalidatePath("/budget");
  return { status: "ok" };
}

/**
 * Merges one category into another of the same kind.
 *
 * Transactions and recurring series are repointed; budgets move where the target has no
 * budget for the same month, and the duplicates are deleted — the target's plan already
 * covers those periods, and the summary says how many were dropped, never silently. The
 * two kinds must match: merging an expense into an income category would move history to
 * the wrong side of every report.
 */
export async function mergeCategoriesAction(values: unknown): Promise<ActionResult> {
  const user = await requireModule("budget", "write");

  const parsed = categoryMergeSchema.safeParse(values);
  if (!parsed.success) {
    return invalidResult(parsed.error);
  }

  const input = parsed.data;

  if (input.sourceId === input.targetId) {
    return rejectedResult("targetId", "Choisissez une catégorie cible différente de la source.");
  }

  try {
    const [source, target] = await Promise.all([
      findCategory(user.workspace.id, input.sourceId),
      findCategory(user.workspace.id, input.targetId),
    ]);

    if (!source) {
      return rejectedResult("sourceId", "Catégorie source introuvable.");
    }
    if (!target) {
      return rejectedResult("targetId", "Catégorie cible introuvable.");
    }
    if (source.kind !== target.kind) {
      return rejectedResult(
        "targetId",
        "Les deux catégories doivent être du même type (recette ou dépense) : fusionner une dépense vers une recette déplacerait son histoire du mauvais côté.",
      );
    }

    const summary = await mergeCategories(user.workspace.id, source.id, target.id);
    if (!summary) {
      return rejectedResult("sourceId", "Catégorie source introuvable : elle a peut-être déjà été fusionnée entre-temps.");
    }

    const parts: string[] = [];
    if (summary.movedTransactions > 0) {
      parts.push(`${summary.movedTransactions} opération${summary.movedTransactions > 1 ? "s" : ""}`);
    }
    if (summary.movedRecurring > 0) {
      parts.push(`${summary.movedRecurring} série${summary.movedRecurring > 1 ? "s" : ""} récurrente${summary.movedRecurring > 1 ? "s" : ""}`);
    }
    if (summary.movedBudgets > 0) {
      parts.push(`${summary.movedBudgets} budget${summary.movedBudgets > 1 ? "s" : ""}`);
    }
    if (summary.droppedBudgets > 0) {
      parts.push(
        `${summary.droppedBudgets} budget${summary.droppedBudgets > 1 ? "s" : ""} en doublon supprimé${summary.droppedBudgets > 1 ? "s" : ""} (« ${target.name} » couvrait déjà ces mois)`,
      );
    }

    revalidatePath("/budget");
    return {
      status: "ok",
      message:
        parts.length === 0
          ? `« ${source.name} » fusionnée dans « ${target.name} » : rien d'autre à déplacer.`
          : `« ${source.name} » fusionnée dans « ${target.name} » : ${parts.join(", ")}.`,
    };
  } catch (error) {
    return unexpectedResult("mergeCategories", error);
  }
}

/**
 * Deletes one category. Deliberately not a merge: the screen shows the usage counts
 * first, because the schema rules are unforgiving — transactions lose their category
 * (their amounts stay), and the category's budgets are deleted with it.
 */
export async function deleteCategoryAction(values: unknown): Promise<ActionResult> {
  const user = await requireModule("budget", "write");

  const parsed = recordIdInput.safeParse(values);
  if (!parsed.success) {
    return invalidResult(parsed.error);
  }

  try {
    const deleted = await deleteCategory(user.workspace.id, parsed.data.id);
    if (!deleted) {
      return rejectedResult("id", "Catégorie introuvable : elle a peut-être déjà été supprimée.");
    }
  } catch (error) {
    return unexpectedResult("deleteCategory", error);
  }

  revalidatePath("/budget");
  return { status: "ok" };
}

/**
 * Records an internal transfer as two linked movements, in one action.
 *
 * The amount is a positive magnitude and the direction comes from the two accounts; both
 * must carry the same currency — the app never converts, so a linked transfer exists
 * within one currency only. The two legs share a `transferGroupId` and are written in a
 * single database transaction: either both exist or neither does. An empty label gets the
 * default pair (« Virement vers … » / « Virement depuis … »), which reads well on both
 * account statements.
 */
export async function createTransferAction(values: unknown): Promise<ActionResult> {
  const user = await requireModule("budget", "write");

  const parsed = transferInputSchema.safeParse(values);
  if (!parsed.success) {
    return invalidResult(parsed.error);
  }

  const input = parsed.data;

  try {
    const [from, to] = await Promise.all([
      findAccount(user.workspace.id, input.fromAccountId),
      findAccount(user.workspace.id, input.toAccountId),
    ]);

    if (!from) {
      return rejectedResult("fromAccountId", "Compte source introuvable.");
    }
    if (!to) {
      return rejectedResult("toAccountId", "Compte de destination introuvable.");
    }

    if (from.currency !== to.currency) {
      return rejectedResult(
        "toAccountId",
        `Le compte source est en ${from.currency} et le compte de destination en ${to.currency} : un virement lié ne traverse pas les devises, aucune conversion n'est faite.`,
      );
    }

    const labels = input.label
      ? { source: input.label, destination: input.label }
      : defaultTransferLabels(from.name, to.name);

    await createTransferGroup({
      workspaceId: user.workspace.id,
      fromAccountId: from.id,
      toAccountId: to.id,
      currency: from.currency,
      amount: input.amount,
      operationDate: input.operationDate,
      sourceLabel: labels.source,
      destinationLabel: labels.destination,
      notes: input.notes,
    });
  } catch (error) {
    return unexpectedResult("createTransfer", error);
  }

  revalidatePath("/budget");
  revalidatePath("/dashboard");
  return {
    status: "ok",
    message:
      "Virement enregistré : les deux mouvements sont liés et se suppriment ensemble.",
  };
}

/**
 * Ticks or unticks one transaction against a bank statement.
 *
 * The tick only writes its own date: correcting the line stays the entry form's job.
 * Each leg of a linked transfer is ticked from its own account's statement, so a leg is
 * tickable like any other row.
 */
export async function setTransactionReconciledAction(values: unknown): Promise<ActionResult> {
  const user = await requireModule("budget", "write");

  const parsed = reconciliationInputSchema.safeParse(values);
  if (!parsed.success) {
    return invalidResult(parsed.error);
  }

  try {
    const updated = await setTransactionReconciled({
      workspaceId: user.workspace.id,
      transactionId: parsed.data.id,
      reconciled: parsed.data.reconciled,
    });

    if (!updated) {
      return rejectedResult("id", "Opération introuvable : elle a peut-être été supprimée entre-temps.");
    }
  } catch (error) {
    return unexpectedResult("setTransactionReconciled", error);
  }

  revalidatePath("/budget");
  return { status: "ok" };
}

/**
 * Copies the previous month's budgets onto the month being displayed.
 *
 * Only genuinely missing envelopes are created: a row the owner already adjusted in the
 * target month stays untouched, and the summary says how many were left alone. An empty
 * source month is a plain answer, not an error.
 */
export async function copyBudgetsAction(values: unknown): Promise<ActionResult> {
  const user = await requireModule("budget", "write");

  const parsed = budgetCopySchema.safeParse(values);
  if (!parsed.success) {
    return invalidResult(parsed.error);
  }

  const target = parsed.data.month;

  try {
    const previousKey = shiftMonthKey(budgetMonthKey(target.year, target.month), -1);
    const { year: previousYear, month: previousMonth } = parseMonthKey(previousKey);

    const { created, skipped } = await copyBudgets({
      workspaceId: user.workspace.id,
      from: { year: previousYear, month: previousMonth },
      to: target,
    });

    revalidatePath("/budget");

    if (created === 0 && skipped === 0) {
      return {
        status: "ok",
        message: "Le mois précédent n'a aucun budget à copier. Créez-en d'abord un, il servira de modèle le mois prochain.",
      };
    }

    if (created === 0) {
      return {
        status: "ok",
        message: `Rien à copier : les ${skipped} budget${skipped > 1 ? "s" : ""} du mois précédent existent déjà ce mois-ci, dans leur version actuelle.`,
      };
    }

    return {
      status: "ok",
      message: `${created} budget${created > 1 ? "s" : ""} copié${created > 1 ? "s" : ""} depuis ${formatMonthLabel(previousYear, previousMonth)}${skipped > 0 ? ` — ${skipped} déjà présent${skipped > 1 ? "s" : ""}, laissé${skipped > 1 ? "s" : ""} tel${skipped > 1 ? "s" : ""} quel${skipped > 1 ? "s" : ""}` : ""}.`,
    };
  } catch (error) {
    return unexpectedResult("copyBudgets", error);
  }
}
