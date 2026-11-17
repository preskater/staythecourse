import Decimal from "decimal.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const requireUserMock = vi.fn();
const deleteTransactionMock = vi.fn();
const createTransactionMock = vi.fn();
const updateTransactionMock = vi.fn();
const findAccountMock = vi.fn();
const findCategoryMock = vi.fn();
const findBudgetByPeriodMock = vi.fn();
const createBudgetMock = vi.fn();
const updateBudgetMock = vi.fn();
const deleteBudgetMock = vi.fn();
const findSalarySettingMock = vi.fn();
const upsertSalarySettingMock = vi.fn();
const listSalaryRatesMock = vi.fn();
const upsertSalaryRateMock = vi.fn();
const listWorkDaysMock = vi.fn();
const findWorkDayMock = vi.fn();
const createWorkDayMock = vi.fn();
const updateWorkDayMock = vi.fn();
const deleteWorkDayMock = vi.fn();
const ensureCategoryMock = vi.fn();
const findTransactionByExternalRefMock = vi.fn();
const findTransactionMock = vi.fn();
const findCashflowLinkedToTransactionMock = vi.fn();
const revalidatePathMock = vi.fn();
const updateAccountMock = vi.fn();
const setAccountArchivedMock = vi.fn();
const findManagedAccountMock = vi.fn();
const countAccountTransactionsMock = vi.fn();
const updateCategoryMock = vi.fn();
const countCategoryReferencesMock = vi.fn();
const mergeCategoriesMock = vi.fn();
const deleteCategoryMock = vi.fn();
const createTransferGroupMock = vi.fn();
const setTransactionReconciledMock = vi.fn();
const copyBudgetsMock = vi.fn();
const recordAuditEventSafelyMock = vi.fn();

vi.mock("@/lib/auth/guard", () => ({ requireModule: (key: string) => requireUserMock(key) }));
vi.mock("@/modules/audit/repository", () => ({
  recordAuditEventSafely: (...args: unknown[]) => recordAuditEventSafelyMock(...args),
}));
vi.mock("@/modules/budget/repository", () => ({
  deleteTransaction: (...args: unknown[]) => deleteTransactionMock(...args),
  createTransaction: (...args: unknown[]) => createTransactionMock(...args),
  updateTransaction: (...args: unknown[]) => updateTransactionMock(...args),
  findAccount: (...args: unknown[]) => findAccountMock(...args),
  findCategory: (...args: unknown[]) => findCategoryMock(...args),
  findBudgetByPeriod: (...args: unknown[]) => findBudgetByPeriodMock(...args),
  createBudget: (...args: unknown[]) => createBudgetMock(...args),
  updateBudget: (...args: unknown[]) => updateBudgetMock(...args),
  deleteBudget: (...args: unknown[]) => deleteBudgetMock(...args),
  findSalarySetting: (...args: unknown[]) => findSalarySettingMock(...args),
  upsertSalarySetting: (...args: unknown[]) => upsertSalarySettingMock(...args),
  listSalaryRates: (...args: unknown[]) => listSalaryRatesMock(...args),
  upsertSalaryRate: (...args: unknown[]) => upsertSalaryRateMock(...args),
  listWorkDays: (...args: unknown[]) => listWorkDaysMock(...args),
  findWorkDay: (...args: unknown[]) => findWorkDayMock(...args),
  createWorkDay: (...args: unknown[]) => createWorkDayMock(...args),
  updateWorkDay: (...args: unknown[]) => updateWorkDayMock(...args),
  deleteWorkDay: (...args: unknown[]) => deleteWorkDayMock(...args),
  ensureCategory: (...args: unknown[]) => ensureCategoryMock(...args),
  findTransactionByExternalRef: (...args: unknown[]) =>
    findTransactionByExternalRefMock(...args),
  findTransaction: (...args: unknown[]) => findTransactionMock(...args),
  updateAccount: (...args: unknown[]) => updateAccountMock(...args),
  setAccountArchived: (...args: unknown[]) => setAccountArchivedMock(...args),
  findManagedAccount: (...args: unknown[]) => findManagedAccountMock(...args),
  countAccountTransactions: (...args: unknown[]) => countAccountTransactionsMock(...args),
  updateCategory: (...args: unknown[]) => updateCategoryMock(...args),
  countCategoryReferences: (...args: unknown[]) => countCategoryReferencesMock(...args),
  mergeCategories: (...args: unknown[]) => mergeCategoriesMock(...args),
  deleteCategory: (...args: unknown[]) => deleteCategoryMock(...args),
  createTransferGroup: (...args: unknown[]) => createTransferGroupMock(...args),
  setTransactionReconciled: (...args: unknown[]) => setTransactionReconciledMock(...args),
  copyBudgets: (...args: unknown[]) => copyBudgetsMock(...args),
  createAccount: vi.fn(),
  createCategory: vi.fn(),
}));
vi.mock("@/modules/real-estate/repository", () => ({
  findCashflowLinkedToTransaction: (...args: unknown[]) =>
    findCashflowLinkedToTransactionMock(...args),
}));
vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => revalidatePathMock(...args),
}));

const {
  adjustWorkDayHoursAction,
  bookSalaryAction,
  copyBudgetsAction,
  createBudgetAction,
  createTransactionAction,
  createTransferAction,
  cycleWorkDayAction,
  deleteBudgetAction,
  deleteCategoryAction,
  deleteTransactionAction,
  mergeCategoriesAction,
  saveSalarySettingAction,
  setAccountArchivedAction,
  setTransactionReconciledAction,
  updateAccountAction,
  updateBudgetAction,
  updateCategoryAction,
  updateTransactionAction,
} = await import("./actions");

beforeEach(() => {
  recordAuditEventSafelyMock.mockReset();
});

/**
 * Fictitious data only. The action is the only place that decides whether a deletion
 * is allowed, so it is tested against mocked repositories: no test touches a database.
 */
const OWNER = {
  id: "owner-1",
  email: "owner@example.test",
  name: null,
  workspace: { id: "ws-owner-1", modules: ["budget", "real-estate", "development"] },
};

describe("deleteTransactionAction", () => {
  beforeEach(() => {
    requireUserMock.mockReset().mockResolvedValue(OWNER);
    deleteTransactionMock
      .mockReset()
      .mockResolvedValue({ deleted: true, deletedCount: 1, grouped: false });
    findCashflowLinkedToTransactionMock.mockReset().mockResolvedValue(null);
    revalidatePathMock.mockReset();
  });

  it("deletes the transaction of the signed-in owner and refreshes the pages", async () => {
    const result = await deleteTransactionAction({ id: "tx-1" });

    expect(result).toEqual({ status: "ok" });
    // The owner is always part of the query: a foreign identifier matches nothing.
    expect(deleteTransactionMock).toHaveBeenCalledWith(OWNER.workspace.id, "tx-1");
    expect(revalidatePathMock).toHaveBeenCalledWith("/budget");
    expect(revalidatePathMock).toHaveBeenCalledWith("/dashboard");

    expect(recordAuditEventSafelyMock).toHaveBeenCalledTimes(1);
    expect(recordAuditEventSafelyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "transaction.delete",
        entityId: "tx-1",
        outcome: "SUCCESS",
      }),
    );
  });

  it("refuses to delete a transaction a property cashflow is linked to", async () => {
    findCashflowLinkedToTransactionMock.mockResolvedValue({
      id: "cashflow-1",
      propertyName: "Appartement de test",
    });

    const result = await deleteTransactionAction({ id: "tx-1" });

    expect(result.status).toBe("invalid");
    // The message must name the property: that is what makes it actionable.
    expect(result.status === "invalid" && result.message).toContain("Appartement de test");
    // And nothing is deleted: the cashflow would be left with no amount at all.
    expect(deleteTransactionMock).not.toHaveBeenCalled();
    // A refusal writes nothing: the trail records what happened, not what was tried.
    expect(recordAuditEventSafelyMock).not.toHaveBeenCalled();
  });

  it("reports an unknown or already deleted transaction instead of pretending", async () => {
    deleteTransactionMock.mockResolvedValue({ deleted: false, deletedCount: 0, grouped: false });

    const result = await deleteTransactionAction({ id: "tx-gone" });

    expect(result.status).toBe("invalid");
    expect(result.status === "invalid" && result.message).toMatch(/introuvable/);
    expect(recordAuditEventSafelyMock).not.toHaveBeenCalled();
  });

  it("says both movements were removed when the row belongs to a linked transfer", async () => {
    deleteTransactionMock.mockResolvedValue({ deleted: true, deletedCount: 2, grouped: true });

    const result = await deleteTransactionAction({ id: "tx-leg-1" });

    expect(result.status).toBe("ok");
    expect(result.status === "ok" && result.message).toMatch(/deux mouvements/);
  });

  it("rejects a payload without an identifier", async () => {
    const result = await deleteTransactionAction({ id: "   " });

    expect(result.status).toBe("invalid");
    expect(deleteTransactionMock).not.toHaveBeenCalled();
  });

  it("answers with a generic message when the database fails", async () => {
    deleteTransactionMock.mockRejectedValue(new Error("connection lost"));

    const result = await deleteTransactionAction({ id: "tx-1" });

    expect(result).toEqual({
      status: "error",
      message: "Enregistrement impossible pour le moment. Réessayez dans un instant.",
    });
  });

  it("checks the session before touching anything", async () => {
    requireUserMock.mockRejectedValue(new Error("redirect:/login"));

    await expect(deleteTransactionAction({ id: "tx-1" })).rejects.toThrow("redirect:/login");
    expect(deleteTransactionMock).not.toHaveBeenCalled();
  });

  it("is rejected without writing when the budget module is disabled", async () => {
    // `requireModule` answers 404 for a module the workspace has not enabled: a
    // forged POST to the action reaches the guard, never the repository.
    requireUserMock.mockRejectedValue(new Error("not-found"));

    await expect(deleteTransactionAction({ id: "tx-1" })).rejects.toThrow("not-found");
    expect(requireUserMock).toHaveBeenCalledWith("budget");
    expect(deleteTransactionMock).not.toHaveBeenCalled();
  });
});

/** Fictitious rows only. */
const ACCOUNT = {
  id: "account-1",
  name: "Compte courant",
  type: "CHECKING" as const,
  // Deliberately not the default currency: the form cannot send one, so asserting a value
  // other than EUR proves the currency is read from the account rather than defaulted.
  currency: "USD" as const,
};
const CATEGORY = { id: "category-1", name: "Courses", kind: "EXPENSE" as const };

const VALID_FORM = {
  accountId: ACCOUNT.id,
  categoryId: CATEGORY.id,
  type: "EXPENSE" as const,
  label: "Courses du samedi",
  amount: "-45,90",
  operationDate: "2026-09-30",
  notes: "",
};

describe("createTransactionAction", () => {
  beforeEach(() => {
    requireUserMock.mockReset().mockResolvedValue(OWNER);
    findAccountMock.mockReset().mockResolvedValue(ACCOUNT);
    findCategoryMock.mockReset().mockResolvedValue(CATEGORY);
    createTransactionMock.mockReset().mockResolvedValue({ id: "tx-1" });
    updateTransactionMock.mockReset().mockResolvedValue(true);
    revalidatePathMock.mockReset();
  });

  it("stores the row with the currency of its account, scoped to the owner", async () => {
    const result = await createTransactionAction(VALID_FORM);

    expect(result).toEqual({ status: "ok" });
    expect(createTransactionMock).toHaveBeenCalledTimes(1);

    const [input] = createTransactionMock.mock.calls[0] as [Record<string, unknown>];

    expect(input).toMatchObject({
      workspaceId: OWNER.workspace.id,
      accountId: ACCOUNT.id,
      categoryId: CATEGORY.id,
      type: "EXPENSE",
      label: "Courses du samedi",
      currency: ACCOUNT.currency,
      externalRef: null,
    });
    // The typed string became an exact decimal before it reached persistence.
    expect((input.amount as { toFixed(scale: number): string }).toFixed(2)).toBe("-45.90");
    expect(revalidatePathMock).toHaveBeenCalledWith("/budget");

    // One entry, and the payload stays out of it: no label, no amount.
    expect(recordAuditEventSafelyMock).toHaveBeenCalledTimes(1);
    const [audit] = recordAuditEventSafelyMock.mock.calls[0] as [Record<string, unknown>];
    expect(audit).toMatchObject({
      workspaceId: OWNER.workspace.id,
      actorId: OWNER.id,
      action: "transaction.create",
      entityType: "TRANSACTION",
      entityId: "tx-1",
      outcome: "SUCCESS",
    });
    expect(JSON.stringify(audit)).not.toContain("Courses du samedi");
    expect(JSON.stringify(audit)).not.toContain("45.90");
  });

  it("refuses an account that is not the owner's", async () => {
    findAccountMock.mockResolvedValue(null);

    const result = await createTransactionAction(VALID_FORM);

    expect(result.status).toBe("invalid");
    expect(result.status === "invalid" && result.fieldErrors.accountId).toHaveLength(1);
    expect(createTransactionMock).not.toHaveBeenCalled();
  });
});

describe("updateTransactionAction", () => {
  const validUpdate = { ...VALID_FORM, id: "tx-1" };

  beforeEach(() => {
    requireUserMock.mockReset().mockResolvedValue(OWNER);
    findAccountMock.mockReset().mockResolvedValue(ACCOUNT);
    findCategoryMock.mockReset().mockResolvedValue(CATEGORY);
    createTransactionMock.mockReset().mockResolvedValue({ id: "tx-1" });
    updateTransactionMock.mockReset().mockResolvedValue(true);
    findTransactionMock
      .mockReset()
      .mockResolvedValue({ id: "tx-1", transferGroupId: null });
    revalidatePathMock.mockReset();
  });

  it("refuses to edit one leg of a linked transfer: the two halves are one movement", async () => {
    findTransactionMock.mockResolvedValue({ id: "tx-1", transferGroupId: "group-1" });

    const result = await updateTransactionAction(validUpdate);

    expect(result.status).toBe("invalid");
    expect(result.status === "invalid" && result.message).toMatch(/virement/);
    expect(updateTransactionMock).not.toHaveBeenCalled();
  });

  it("reports a row that disappeared between the read and the write", async () => {
    findTransactionMock.mockResolvedValue(null);

    const result = await updateTransactionAction(validUpdate);

    expect(result.status).toBe("invalid");
    expect(updateTransactionMock).not.toHaveBeenCalled();
  });

  it("replaces every editable field of the owner's own row", async () => {
    const result = await updateTransactionAction({
      ...validUpdate,
      label: "Courses corrigées",
      type: "TRANSFER",
      categoryId: "",
      amount: "120,00",
    });

    expect(result).toEqual({ status: "ok" });
    expect(updateTransactionMock).toHaveBeenCalledTimes(1);

    const [workspaceId, transactionId, write] = updateTransactionMock.mock.calls[0] as [
      string,
      string,
      Record<string, unknown>,
    ];

    // The owner is always part of the query: a foreign identifier matches no row.
    expect(workspaceId).toBe(OWNER.workspace.id);
    expect(transactionId).toBe("tx-1");
    expect(write).toMatchObject({
      accountId: ACCOUNT.id,
      // An unselected category is stored as null, not as an empty string.
      categoryId: null,
      type: "TRANSFER",
      label: "Courses corrigées",
      currency: ACCOUNT.currency,
    });
    expect((write.amount as { toFixed(scale: number): string }).toFixed(2)).toBe("120.00");
    expect(revalidatePathMock).toHaveBeenCalledWith("/budget");
    expect(revalidatePathMock).toHaveBeenCalledWith("/dashboard");

    const [audit] = recordAuditEventSafelyMock.mock.calls[0] as [Record<string, unknown>];
    expect(audit).toMatchObject({
      action: "transaction.update",
      entityId: "tx-1",
      outcome: "SUCCESS",
    });
    expect(JSON.stringify(audit)).not.toContain("Courses corrigées");
    expect(JSON.stringify(audit)).not.toContain("120.00");
  });

  it("never sends an external reference: a corrected import stays an import", async () => {
    await updateTransactionAction(validUpdate);

    const [, , write] = updateTransactionMock.mock.calls[0] as [string, string, object];

    expect(write).not.toHaveProperty("externalRef");
  });

  it("refuses an account that is not the owner's", async () => {
    findAccountMock.mockResolvedValue(null);

    const result = await updateTransactionAction(validUpdate);

    expect(result.status).toBe("invalid");
    expect(updateTransactionMock).not.toHaveBeenCalled();
  });

  it("refuses a category whose kind contradicts the type", async () => {
    findCategoryMock.mockResolvedValue({ id: "category-2", name: "Salaire", kind: "INCOME" });

    const result = await updateTransactionAction(validUpdate);

    expect(result.status).toBe("invalid");
    expect(result.status === "invalid" && result.fieldErrors.categoryId).toHaveLength(1);
    expect(updateTransactionMock).not.toHaveBeenCalled();
  });

  it("applies the sign rule shared with the creation", async () => {
    const negativeIncome = { ...validUpdate, type: "INCOME" as const, amount: "-10,00" };

    const created = await createTransactionAction(negativeIncome);
    const updated = await updateTransactionAction(negativeIncome);

    // One resolver, two callers: neither can accept what the other refuses.
    expect(created.status).toBe("invalid");
    expect(updated.status).toBe("invalid");
    expect(createTransactionMock).not.toHaveBeenCalled();
    expect(updateTransactionMock).not.toHaveBeenCalled();
  });

  it("reports a row that matched nothing instead of answering success", async () => {
    updateTransactionMock.mockResolvedValue(false);

    const result = await updateTransactionAction(validUpdate);

    expect(result.status).toBe("invalid");
    expect(result.status === "invalid" && result.message).toMatch(/introuvable/);
    // Nothing was written, so the page must not be told the data changed.
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  it("rejects a payload without an identifier before reading anything", async () => {
    const result = await updateTransactionAction({ ...VALID_FORM, id: "" });

    expect(result.status).toBe("invalid");
    expect(findAccountMock).not.toHaveBeenCalled();
    expect(updateTransactionMock).not.toHaveBeenCalled();
  });

  it("answers with a generic message when the database fails", async () => {
    updateTransactionMock.mockRejectedValue(new Error("connection lost"));

    const result = await updateTransactionAction(validUpdate);

    expect(result).toEqual({
      status: "error",
      message: "Enregistrement impossible pour le moment. Réessayez dans un instant.",
    });
  });

  it("checks the session before touching anything", async () => {
    requireUserMock.mockRejectedValue(new Error("redirect:/login"));

    await expect(updateTransactionAction(validUpdate)).rejects.toThrow("redirect:/login");
    expect(updateTransactionMock).not.toHaveBeenCalled();
  });
});

/** Fictitious rows only. */
const BUDGET_CATEGORY = { id: "category-1", name: "Courses", kind: "EXPENSE" as const };
const VALID_BUDGET = {
  categoryId: BUDGET_CATEGORY.id,
  month: "2026-10",
  currency: "EUR",
  amount: "300,00",
};

describe("createBudgetAction", () => {
  beforeEach(() => {
    requireUserMock.mockReset().mockResolvedValue(OWNER);
    findCategoryMock.mockReset().mockResolvedValue(BUDGET_CATEGORY);
    findBudgetByPeriodMock.mockReset().mockResolvedValue(null);
    createBudgetMock.mockReset().mockResolvedValue({ id: "budget-1" });
    revalidatePathMock.mockReset();
  });

  it("stores a positive plan for the owner's own category", async () => {
    const result = await createBudgetAction(VALID_BUDGET);

    expect(result).toEqual({ status: "ok" });
    expect(createBudgetMock).toHaveBeenCalledTimes(1);

    const [input] = createBudgetMock.mock.calls[0] as [Record<string, unknown>];

    expect(input).toMatchObject({
      workspaceId: OWNER.workspace.id,
      categoryId: BUDGET_CATEGORY.id,
      year: 2026,
      month: 10,
      currency: "EUR",
    });
    // The typed string became an exact decimal before it reached persistence.
    expect((input.amount as { toFixed(scale: number): string }).toFixed(2)).toBe("300.00");
    expect(revalidatePathMock).toHaveBeenCalledWith("/budget");
  });

  it("ignores a posted owner instead of trusting it", async () => {
    await createBudgetAction({ ...VALID_BUDGET, workspaceId: "someone-else" });

    const [input] = createBudgetMock.mock.calls[0] as [Record<string, unknown>];

    expect(input.workspaceId).toBe(OWNER.workspace.id);
  });

  it("keeps EUR and USD apart: the same month carries one budget per currency", async () => {
    const euros = await createBudgetAction(VALID_BUDGET);
    const dollars = await createBudgetAction({
      ...VALID_BUDGET,
      currency: "USD",
      amount: "350,00",
    });

    expect(euros).toEqual({ status: "ok" });
    expect(dollars).toEqual({ status: "ok" });

    const currencies = createBudgetMock.mock.calls.map(
      ([input]) => (input as { currency: string }).currency,
    );
    expect(currencies).toEqual(["EUR", "USD"]);
    // The duplicate check asked about each currency separately, not about the month alone.
    expect(findBudgetByPeriodMock).toHaveBeenNthCalledWith(
      2,
      OWNER.workspace.id,
      expect.objectContaining({ currency: "USD" }),
    );
  });

  it("refuses a duplicate month for the same category and currency", async () => {
    findBudgetByPeriodMock.mockResolvedValue({
      id: "budget-existing",
      categoryId: BUDGET_CATEGORY.id,
      year: 2026,
      month: 10,
      currency: "EUR",
    });

    const result = await createBudgetAction(VALID_BUDGET);

    expect(result.status).toBe("invalid");
    expect(result.status === "invalid" && result.message).toMatch(/existe déjà/);
    expect(createBudgetMock).not.toHaveBeenCalled();
  });

  it("turns the database's own uniqueness refusal into the same message", async () => {
    // The pre-check is not a race guard: two requests can cross between the read and
    // the write, and the unique index is what refuses the second one.
    createBudgetMock.mockRejectedValue({ code: "P2002" });

    const result = await createBudgetAction(VALID_BUDGET);

    expect(result.status).toBe("invalid");
    expect(result.status === "invalid" && result.message).toMatch(/existe déjà/);
  });

  it("refuses a category that is not the owner's", async () => {
    findCategoryMock.mockResolvedValue(null);

    const result = await createBudgetAction(VALID_BUDGET);

    expect(result.status).toBe("invalid");
    expect(result.status === "invalid" && result.fieldErrors.categoryId).toHaveLength(1);
    expect(findBudgetByPeriodMock).not.toHaveBeenCalled();
    expect(createBudgetMock).not.toHaveBeenCalled();
  });

  it("refuses an amount that is not a strictly positive number", async () => {
    for (const amount of ["0", "-10,00", "trois cents"]) {
      const result = await createBudgetAction({ ...VALID_BUDGET, amount });

      expect(result.status).toBe("invalid");
    }

    expect(findCategoryMock).not.toHaveBeenCalled();
    expect(createBudgetMock).not.toHaveBeenCalled();
  });

  it("refuses an unsupported currency before reading anything", async () => {
    const result = await createBudgetAction({ ...VALID_BUDGET, currency: "XYZ" });

    expect(result.status).toBe("invalid");
    expect(result.status === "invalid" && result.message).toMatch(/invalides/);
    expect(findCategoryMock).not.toHaveBeenCalled();
    expect(createBudgetMock).not.toHaveBeenCalled();
  });

  it("rejects a month outside the calendar bounds", async () => {
    const result = await createBudgetAction({ ...VALID_BUDGET, month: "2026-13" });

    expect(result.status).toBe("invalid");
    expect(findCategoryMock).not.toHaveBeenCalled();
    expect(createBudgetMock).not.toHaveBeenCalled();
  });

  it("answers with a generic message when the database fails", async () => {
    createBudgetMock.mockRejectedValue(new Error("connection lost"));

    const result = await createBudgetAction(VALID_BUDGET);

    expect(result).toEqual({
      status: "error",
      message: "Enregistrement impossible pour le moment. Réessayez dans un instant.",
    });
  });

  it("checks the session before touching anything", async () => {
    requireUserMock.mockRejectedValue(new Error("redirect:/login"));

    await expect(createBudgetAction(VALID_BUDGET)).rejects.toThrow("redirect:/login");
    expect(findCategoryMock).not.toHaveBeenCalled();
    expect(createBudgetMock).not.toHaveBeenCalled();
  });
});

describe("updateBudgetAction", () => {
  const validUpdate = { ...VALID_BUDGET, id: "budget-1" };

  beforeEach(() => {
    requireUserMock.mockReset().mockResolvedValue(OWNER);
    findCategoryMock.mockReset().mockResolvedValue(BUDGET_CATEGORY);
    findBudgetByPeriodMock.mockReset().mockResolvedValue(null);
    updateBudgetMock.mockReset().mockResolvedValue(true);
    revalidatePathMock.mockReset();
  });

  it("replaces the editable fields of the owner's own row", async () => {
    const result = await updateBudgetAction({ ...validUpdate, amount: "320,00" });

    expect(result).toEqual({ status: "ok" });

    const [workspaceId, budgetId, write] = updateBudgetMock.mock.calls[0] as [
      string,
      string,
      Record<string, unknown>,
    ];

    // The owner is always part of the query: a foreign identifier matches no row.
    expect(workspaceId).toBe(OWNER.workspace.id);
    expect(budgetId).toBe("budget-1");
    expect(write).toMatchObject({
      categoryId: BUDGET_CATEGORY.id,
      year: 2026,
      month: 10,
      currency: "EUR",
    });
    expect((write.amount as { toFixed(scale: number): string }).toFixed(2)).toBe("320.00");
    expect(revalidatePathMock).toHaveBeenCalledWith("/budget");
  });

  it("does not treat the row being edited as a duplicate of itself", async () => {
    findBudgetByPeriodMock.mockResolvedValue({
      id: "budget-1",
      categoryId: BUDGET_CATEGORY.id,
      year: 2026,
      month: 10,
      currency: "EUR",
    });

    const result = await updateBudgetAction(validUpdate);

    expect(result).toEqual({ status: "ok" });
    expect(updateBudgetMock).toHaveBeenCalledTimes(1);
  });

  it("refuses to move the row onto another budget of the same period", async () => {
    findBudgetByPeriodMock.mockResolvedValue({
      id: "budget-existing",
      categoryId: BUDGET_CATEGORY.id,
      year: 2026,
      month: 10,
      currency: "EUR",
    });

    const result = await updateBudgetAction(validUpdate);

    expect(result.status).toBe("invalid");
    expect(result.status === "invalid" && result.message).toMatch(/existe déjà/);
    expect(updateBudgetMock).not.toHaveBeenCalled();
  });

  it("refuses a category that is not the owner's", async () => {
    findCategoryMock.mockResolvedValue(null);

    const result = await updateBudgetAction(validUpdate);

    expect(result.status).toBe("invalid");
    expect(updateBudgetMock).not.toHaveBeenCalled();
  });

  it("reports a row that matched nothing instead of answering success", async () => {
    updateBudgetMock.mockResolvedValue(false);

    const result = await updateBudgetAction(validUpdate);

    expect(result.status).toBe("invalid");
    expect(result.status === "invalid" && result.message).toMatch(/introuvable/);
    // Nothing was written, so the page must not be told the data changed.
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  it("rejects a payload without an identifier before reading anything", async () => {
    const result = await updateBudgetAction({ ...VALID_BUDGET, id: "" });

    expect(result.status).toBe("invalid");
    expect(findCategoryMock).not.toHaveBeenCalled();
    expect(updateBudgetMock).not.toHaveBeenCalled();
  });

  it("checks the session before touching anything", async () => {
    requireUserMock.mockRejectedValue(new Error("redirect:/login"));

    await expect(updateBudgetAction(validUpdate)).rejects.toThrow("redirect:/login");
    expect(updateBudgetMock).not.toHaveBeenCalled();
  });
});

describe("deleteBudgetAction", () => {
  beforeEach(() => {
    requireUserMock.mockReset().mockResolvedValue(OWNER);
    deleteBudgetMock.mockReset().mockResolvedValue(true);
    revalidatePathMock.mockReset();
  });

  it("deletes the budget of the signed-in owner and refreshes the page", async () => {
    const result = await deleteBudgetAction({ id: "budget-1" });

    expect(result).toEqual({ status: "ok" });
    // The owner is always part of the query: a foreign identifier matches nothing.
    expect(deleteBudgetMock).toHaveBeenCalledWith(OWNER.workspace.id, "budget-1");
    expect(revalidatePathMock).toHaveBeenCalledWith("/budget");
  });

  it("reports an unknown or already deleted budget instead of pretending", async () => {
    deleteBudgetMock.mockResolvedValue(false);

    const result = await deleteBudgetAction({ id: "budget-gone" });

    expect(result.status).toBe("invalid");
    expect(result.status === "invalid" && result.message).toMatch(/introuvable/);
  });

  it("rejects a payload without an identifier", async () => {
    const result = await deleteBudgetAction({ id: "   " });

    expect(result.status).toBe("invalid");
    expect(deleteBudgetMock).not.toHaveBeenCalled();
  });

  it("answers with a generic message when the database fails", async () => {
    deleteBudgetMock.mockRejectedValue(new Error("connection lost"));

    const result = await deleteBudgetAction({ id: "budget-1" });

    expect(result).toEqual({
      status: "error",
      message: "Enregistrement impossible pour le moment. Réessayez dans un instant.",
    });
  });

  it("checks the session before touching anything", async () => {
    requireUserMock.mockRejectedValue(new Error("redirect:/login"));

    await expect(deleteBudgetAction({ id: "budget-1" })).rejects.toThrow("redirect:/login");
    expect(deleteBudgetMock).not.toHaveBeenCalled();
  });
});

/** Fictitious salary data only. */
const SALARY_SETTING = {
  hoursPerDay: new Decimal("7.5"),
  currency: "EUR" as const,
};

/** One change point in August, so October resolves to 20.50 €. */
const SALARY_RATES = [{ year: 2026, month: 8, hourlyRate: new Decimal("20.50") }];

const WORK_DATE = new Date("2026-10-05T00:00:00.000Z");

describe("saveSalarySettingAction", () => {
  beforeEach(() => {
    requireUserMock.mockReset().mockResolvedValue(OWNER);
    listSalaryRatesMock.mockReset().mockResolvedValue([]);
    upsertSalaryRateMock.mockReset().mockResolvedValue(undefined);
    upsertSalarySettingMock.mockReset().mockResolvedValue(undefined);
    revalidatePathMock.mockReset();
  });

  it("stores the month's rate as a change point, plus the global options", async () => {
    const result = await saveSalarySettingAction({
      month: "2026-10",
      hourlyRate: "20,50",
      hoursPerDay: "7,5",
      currency: "EUR",
    });

    expect(result).toEqual({ status: "ok" });
    expect(upsertSalaryRateMock).toHaveBeenCalledTimes(1);

    const [rateInput] = upsertSalaryRateMock.mock.calls[0] as [Record<string, unknown>];

    expect(rateInput.workspaceId).toBe(OWNER.workspace.id);
    expect(rateInput.year).toBe(2026);
    expect(rateInput.month).toBe(10);
    // The typed string became an exact decimal before it reached persistence.
    expect((rateInput.hourlyRate as { toFixed(scale: number): string }).toFixed(2)).toBe(
      "20.50",
    );

    const [settingInput] = upsertSalarySettingMock.mock.calls[0] as [Record<string, unknown>];

    expect(settingInput.workspaceId).toBe(OWNER.workspace.id);
    expect(settingInput.currency).toBe("EUR");
    expect((settingInput.hoursPerDay as { toFixed(scale: number): string }).toFixed(2)).toBe(
      "7.50",
    );
    expect(revalidatePathMock).toHaveBeenCalledWith("/budget");

    const [audit] = recordAuditEventSafelyMock.mock.calls[0] as [Record<string, unknown>];
    expect(audit).toMatchObject({
      action: "rate.write",
      entityType: "SALARY_RATE",
      entityId: "2026-10",
      metadata: { year: 2026, month: 10, currency: "EUR" },
    });
    // The rate itself is financial data: the entry keeps the period, not the amount.
    expect(JSON.stringify(audit)).not.toContain("20.50");
  });

  it("writes no redundant change point when the month's rate is unchanged", async () => {
    listSalaryRatesMock.mockResolvedValue(SALARY_RATES);

    const result = await saveSalarySettingAction({
      month: "2026-10",
      hourlyRate: "20,50",
      hoursPerDay: "8",
      currency: "EUR",
    });

    expect(result).toEqual({ status: "ok" });
    // Editing the day length must not sprinkle change points: only the options move.
    expect(upsertSalaryRateMock).not.toHaveBeenCalled();
    expect(upsertSalarySettingMock).toHaveBeenCalledTimes(1);
    // Nothing rate-shaped changed, so nothing rate-shaped is logged.
    expect(recordAuditEventSafelyMock).not.toHaveBeenCalled();
  });

  it("refuses a rate that is not strictly positive, before writing", async () => {
    for (const hourlyRate of ["0", "-1", "vingt"]) {
      const result = await saveSalarySettingAction({
        month: "2026-10",
        hourlyRate,
        hoursPerDay: "7",
        currency: "EUR",
      });

      expect(result.status).toBe("invalid");
    }

    expect(upsertSalaryRateMock).not.toHaveBeenCalled();
    expect(upsertSalarySettingMock).not.toHaveBeenCalled();
  });

  it("refuses an implausible day length", async () => {
    const result = await saveSalarySettingAction({
      month: "2026-10",
      hourlyRate: "20",
      hoursPerDay: "25",
      currency: "EUR",
    });

    expect(result.status).toBe("invalid");
    expect(upsertSalaryRateMock).not.toHaveBeenCalled();
  });

  it("refuses a month that does not exist", async () => {
    const result = await saveSalarySettingAction({
      month: "2026-13",
      hourlyRate: "20",
      hoursPerDay: "7",
      currency: "EUR",
    });

    expect(result.status).toBe("invalid");
    expect(upsertSalaryRateMock).not.toHaveBeenCalled();
  });

  it("checks the session before touching anything", async () => {
    requireUserMock.mockRejectedValue(new Error("redirect:/login"));

    await expect(
      saveSalarySettingAction({
        month: "2026-10",
        hourlyRate: "20",
        hoursPerDay: "7",
        currency: "EUR",
      }),
    ).rejects.toThrow("redirect:/login");
    expect(upsertSalaryRateMock).not.toHaveBeenCalled();
  });

  it("answers with a generic message when the database fails", async () => {
    upsertSalaryRateMock.mockRejectedValue(new Error("connection lost"));

    const result = await saveSalarySettingAction({
      month: "2026-10",
      hourlyRate: "20",
      hoursPerDay: "7",
      currency: "EUR",
    });

    expect(result).toEqual({
      status: "error",
      message: "Enregistrement impossible pour le moment. Réessayez dans un instant.",
    });
  });
});

describe("cycleWorkDayAction", () => {
  beforeEach(() => {
    requireUserMock.mockReset().mockResolvedValue(OWNER);
    findSalarySettingMock.mockReset().mockResolvedValue(SALARY_SETTING);
    listSalaryRatesMock.mockReset().mockResolvedValue(SALARY_RATES);
    findWorkDayMock.mockReset().mockResolvedValue(null);
    createWorkDayMock.mockReset().mockResolvedValue({ id: "work-day-1" });
    updateWorkDayMock.mockReset().mockResolvedValue(true);
    deleteWorkDayMock.mockReset().mockResolvedValue(true);
    revalidatePathMock.mockReset();
  });

  it("plans a day on the first click, with the configured day length", async () => {
    const result = await cycleWorkDayAction({ date: "2026-10-05" });

    expect(result).toEqual({ status: "ok" });
    expect(createWorkDayMock).toHaveBeenCalledTimes(1);

    const [input] = createWorkDayMock.mock.calls[0] as [Record<string, unknown>];

    // The owner is always part of the query, and the day length is copied onto the row.
    expect(input.workspaceId).toBe(OWNER.workspace.id);
    expect(input.status).toBe("PLANNED");
    expect((input.date as Date).toISOString()).toBe(WORK_DATE.toISOString());
    expect((input.hours as { toFixed(scale: number): string }).toFixed(2)).toBe("7.50");
    expect(revalidatePathMock).toHaveBeenCalledWith("/budget");
  });

  it("turns a planned day into a worked day on the second click", async () => {
    findWorkDayMock.mockResolvedValue({
      date: WORK_DATE,
      status: "PLANNED",
      hours: new Decimal("7.5"),
    });

    const result = await cycleWorkDayAction({ date: "2026-10-05" });

    expect(result).toEqual({ status: "ok" });
    expect(updateWorkDayMock).toHaveBeenCalledWith(OWNER.workspace.id, WORK_DATE, {
      status: "WORKED",
    });
    // The hours are untouched by a status change.
    const [, , write] = updateWorkDayMock.mock.calls[0] as [string, Date, Record<string, unknown>];
    expect(write).not.toHaveProperty("hours");
  });

  it("removes the day on the third click", async () => {
    findWorkDayMock.mockResolvedValue({
      date: WORK_DATE,
      status: "WORKED",
      hours: new Decimal("8"),
    });

    const result = await cycleWorkDayAction({ date: "2026-10-05" });

    expect(result).toEqual({ status: "ok" });
    expect(deleteWorkDayMock).toHaveBeenCalledWith(OWNER.workspace.id, WORK_DATE);
    expect(createWorkDayMock).not.toHaveBeenCalled();
  });

  it("refuses a click before a rate exists, without writing anything", async () => {
    findSalarySettingMock.mockResolvedValue(null);

    const result = await cycleWorkDayAction({ date: "2026-10-05" });

    expect(result.status).toBe("invalid");
    expect(result.status === "invalid" && result.message).toMatch(/taux horaire/);
    expect(createWorkDayMock).not.toHaveBeenCalled();
    expect(updateWorkDayMock).not.toHaveBeenCalled();
    expect(deleteWorkDayMock).not.toHaveBeenCalled();
  });

  it("refuses to plan a day whose month has no rate at all", async () => {
    listSalaryRatesMock.mockResolvedValue([]);

    const result = await cycleWorkDayAction({ date: "2026-10-05" });

    expect(result.status).toBe("invalid");
    expect(result.status === "invalid" && result.message).toMatch(/Aucun taux horaire/);
    expect(createWorkDayMock).not.toHaveBeenCalled();
  });

  it("rejects an impossible date before reading anything", async () => {
    const result = await cycleWorkDayAction({ date: "2026-02-31" });

    expect(result.status).toBe("invalid");
    expect(findSalarySettingMock).not.toHaveBeenCalled();
    expect(createWorkDayMock).not.toHaveBeenCalled();
  });

  it("checks the session before touching anything", async () => {
    requireUserMock.mockRejectedValue(new Error("redirect:/login"));

    await expect(cycleWorkDayAction({ date: "2026-10-05" })).rejects.toThrow(
      "redirect:/login",
    );
    expect(createWorkDayMock).not.toHaveBeenCalled();
  });

  it("answers with a generic message when the database fails", async () => {
    createWorkDayMock.mockRejectedValue(new Error("connection lost"));

    const result = await cycleWorkDayAction({ date: "2026-10-05" });

    expect(result).toEqual({
      status: "error",
      message: "Enregistrement impossible pour le moment. Réessayez dans un instant.",
    });
  });
});

describe("adjustWorkDayHoursAction", () => {
  beforeEach(() => {
    requireUserMock.mockReset().mockResolvedValue(OWNER);
    findWorkDayMock.mockReset().mockResolvedValue({
      date: WORK_DATE,
      status: "PLANNED",
      hours: new Decimal("7.5"),
    });
    updateWorkDayMock.mockReset().mockResolvedValue(true);
    revalidatePathMock.mockReset();
  });

  it("adds half an hour to the owner's own day", async () => {
    const result = await adjustWorkDayHoursAction({
      date: "2026-10-05",
      direction: "UP",
    });

    expect(result).toEqual({ status: "ok" });
    expect(updateWorkDayMock).toHaveBeenCalledTimes(1);

    const [workspaceId, date, write] = updateWorkDayMock.mock.calls[0] as [
      string,
      Date,
      Record<string, unknown>,
    ];

    expect(workspaceId).toBe(OWNER.workspace.id);
    expect(date.toISOString()).toBe(WORK_DATE.toISOString());
    expect((write.hours as { toFixed(scale: number): string }).toFixed(2)).toBe("8.00");
    // An hours write must not move the status.
    expect(write).not.toHaveProperty("status");
  });

  it("removes half an hour", async () => {
    await adjustWorkDayHoursAction({ date: "2026-10-05", direction: "DOWN" });

    const [, , write] = updateWorkDayMock.mock.calls[0] as [string, Date, Record<string, unknown>];

    expect((write.hours as { toFixed(scale: number): string }).toFixed(2)).toBe("7.00");
  });

  it("stays at the lower bound without writing", async () => {
    findWorkDayMock.mockResolvedValue({
      date: WORK_DATE,
      status: "WORKED",
      hours: new Decimal("0.5"),
    });

    const result = await adjustWorkDayHoursAction({
      date: "2026-10-05",
      direction: "DOWN",
    });

    expect(result).toEqual({ status: "ok" });
    expect(updateWorkDayMock).not.toHaveBeenCalled();
  });

  it("reports a day that is no longer clicked", async () => {
    findWorkDayMock.mockResolvedValue(null);

    const result = await adjustWorkDayHoursAction({
      date: "2026-10-05",
      direction: "UP",
    });

    expect(result.status).toBe("invalid");
    expect(result.status === "invalid" && result.message).toMatch(/rechargez/);
    expect(updateWorkDayMock).not.toHaveBeenCalled();
  });

  it("rejects a direction that is not up or down", async () => {
    const result = await adjustWorkDayHoursAction({
      date: "2026-10-05",
      direction: "SIDEWAYS",
    });

    expect(result.status).toBe("invalid");
    expect(findWorkDayMock).not.toHaveBeenCalled();
    expect(updateWorkDayMock).not.toHaveBeenCalled();
  });

  it("checks the session before touching anything", async () => {
    requireUserMock.mockRejectedValue(new Error("redirect:/login"));

    await expect(
      adjustWorkDayHoursAction({ date: "2026-10-05", direction: "UP" }),
    ).rejects.toThrow("redirect:/login");
    expect(updateWorkDayMock).not.toHaveBeenCalled();
  });
});

/** Fictitious booking data only. */
const EUR_ACCOUNT = {
  id: "account-eur",
  name: "Compte courant",
  type: "CHECKING" as const,
  currency: "EUR" as const,
};
const SALARY_CATEGORY = { id: "category-salary", name: "Salaire", kind: "INCOME" as const };
const BOOKING = { month: "2026-10", accountId: EUR_ACCOUNT.id, date: "2026-10-31" };

describe("bookSalaryAction", () => {
  beforeEach(() => {
    requireUserMock.mockReset().mockResolvedValue(OWNER);
    findSalarySettingMock.mockReset().mockResolvedValue(SALARY_SETTING);
    listSalaryRatesMock.mockReset().mockResolvedValue(SALARY_RATES);
    findAccountMock.mockReset().mockResolvedValue(EUR_ACCOUNT);
    findTransactionByExternalRefMock.mockReset().mockResolvedValue(null);
    listWorkDaysMock.mockReset().mockResolvedValue([
      { date: WORK_DATE, status: "WORKED", hours: new Decimal("8") },
      {
        date: new Date("2026-10-06T00:00:00.000Z"),
        status: "PLANNED",
        hours: new Decimal("7.5"),
      },
    ]);
    ensureCategoryMock.mockReset().mockResolvedValue(SALARY_CATEGORY);
    createTransactionMock.mockReset().mockResolvedValue({ id: "tx-salary" });
    revalidatePathMock.mockReset();
  });

  it("books the month's simulated amount as an income in the « Salaire » category", async () => {
    const result = await bookSalaryAction(BOOKING);

    expect(result).toEqual({ status: "ok" });

    // The default category is ensured owner-scoped: created if the owner has none.
    expect(ensureCategoryMock).toHaveBeenCalledWith({
      workspaceId: OWNER.workspace.id,
      name: "Salaire",
      kind: "INCOME",
    });

    const [input] = createTransactionMock.mock.calls[0] as [Record<string, unknown>];

    expect(input).toMatchObject({
      workspaceId: OWNER.workspace.id,
      accountId: EUR_ACCOUNT.id,
      categoryId: SALARY_CATEGORY.id,
      type: "INCOME",
      label: "Salaire octobre 2026",
      currency: "EUR",
      notes: null,
      // The stable reference is what makes a second booking of the month impossible.
      externalRef: "salary:2026-10",
    });
    // 15.5 clicked hours × 20.50: the planned day counts too, exactly once.
    expect((input.amount as { toFixed(scale: number): string }).toFixed(2)).toBe("317.75");
    expect((input.operationDate as Date).toISOString()).toBe("2026-10-31T00:00:00.000Z");
    expect(revalidatePathMock).toHaveBeenCalledWith("/budget");
    expect(revalidatePathMock).toHaveBeenCalledWith("/dashboard");

    expect(recordAuditEventSafelyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "transaction.salary_book",
        entityId: "tx-salary",
        metadata: { month: "2026-10", currency: "EUR" },
      }),
    );
  });

  it("books a month that is only planned: the calendar is the source, not the day states", async () => {
    listWorkDaysMock.mockResolvedValue([
      { date: WORK_DATE, status: "PLANNED", hours: new Decimal("8") },
      {
        date: new Date("2026-10-06T00:00:00.000Z"),
        status: "PLANNED",
        hours: new Decimal("7.5"),
      },
    ]);

    const result = await bookSalaryAction(BOOKING);

    expect(result).toEqual({ status: "ok" });
    const [input] = createTransactionMock.mock.calls[0] as [Record<string, unknown>];
    // 15.5 planned hours × 20.50 — a planned day counts once, like a worked one.
    expect((input.amount as { toFixed(scale: number): string }).toFixed(2)).toBe("317.75");
  });

  it("refuses a month without a single clicked day", async () => {
    listWorkDaysMock.mockResolvedValue([]);

    const result = await bookSalaryAction(BOOKING);

    expect(result.status).toBe("invalid");
    expect(result.status === "invalid" && result.message).toMatch(/rien à enregistrer/);
    expect(ensureCategoryMock).not.toHaveBeenCalled();
    expect(createTransactionMock).not.toHaveBeenCalled();
  });

  it("refuses an account in another currency instead of converting", async () => {
    // The shared ACCOUNT fixture is deliberately in USD.
    findAccountMock.mockResolvedValue(ACCOUNT);

    const result = await bookSalaryAction(BOOKING);

    expect(result.status).toBe("invalid");
    expect(result.status === "invalid" && result.message).toMatch(/devise/);
    expect(createTransactionMock).not.toHaveBeenCalled();
  });

  it("refuses an account that is not the owner's", async () => {
    findAccountMock.mockResolvedValue(null);

    const result = await bookSalaryAction(BOOKING);

    expect(result.status).toBe("invalid");
    expect(createTransactionMock).not.toHaveBeenCalled();
  });

  it("refuses to book before a rate exists", async () => {
    findSalarySettingMock.mockResolvedValue(null);

    const result = await bookSalaryAction(BOOKING);

    expect(result.status).toBe("invalid");
    expect(result.status === "invalid" && result.message).toMatch(/taux horaire/);
    expect(createTransactionMock).not.toHaveBeenCalled();
  });

  it("refuses to book a month that has no rate at all", async () => {
    listSalaryRatesMock.mockResolvedValue([]);

    const result = await bookSalaryAction(BOOKING);

    expect(result.status).toBe("invalid");
    expect(result.status === "invalid" && result.message).toMatch(/Aucun taux horaire/);
    expect(createTransactionMock).not.toHaveBeenCalled();
  });

  it("refuses a month that is already booked", async () => {
    findTransactionByExternalRefMock.mockResolvedValue({ id: "tx-existing" });

    const result = await bookSalaryAction(BOOKING);

    expect(result.status).toBe("invalid");
    expect(result.status === "invalid" && result.message).toMatch(/déjà enregistrée/);
    // The reference identifies the booking, not a label the owner may have edited.
    expect(findTransactionByExternalRefMock).toHaveBeenCalledWith(OWNER.workspace.id, "salary:2026-10");
    expect(createTransactionMock).not.toHaveBeenCalled();
  });

  it("turns the database's own uniqueness refusal into the same message", async () => {
    createTransactionMock.mockRejectedValue({ code: "P2002" });

    const result = await bookSalaryAction(BOOKING);

    expect(result.status).toBe("invalid");
    expect(result.status === "invalid" && result.message).toMatch(/déjà enregistrée/);
  });

  it("rejects an impossible payload before reading anything", async () => {
    const result = await bookSalaryAction({ ...BOOKING, date: "2026-02-31" });

    expect(result.status).toBe("invalid");
    expect(findSalarySettingMock).not.toHaveBeenCalled();
    expect(createTransactionMock).not.toHaveBeenCalled();
  });

  it("checks the session before touching anything", async () => {
    requireUserMock.mockRejectedValue(new Error("redirect:/login"));

    await expect(bookSalaryAction(BOOKING)).rejects.toThrow("redirect:/login");
    expect(createTransactionMock).not.toHaveBeenCalled();
  });

  it("answers with a generic message when the database fails", async () => {
    createTransactionMock.mockRejectedValue(new Error("connection lost"));

    const result = await bookSalaryAction(BOOKING);

    expect(result).toEqual({
      status: "error",
      message: "Enregistrement impossible pour le moment. Réessayez dans un instant.",
    });
  });
});

/**
 * The account, category, transfer and reconciliation actions added with the budget
 * management pass. Same contract as everywhere: mocked repositories, no database, and
 * the owner always comes from the session.
 */

describe("updateAccountAction", () => {
  const ACCOUNT_ROW = {
    id: "account-1",
    name: "Compte courant",
    type: "CHECKING" as const,
    currency: "EUR" as const,
    archivedAt: null,
  };

  beforeEach(() => {
    requireUserMock.mockReset().mockResolvedValue(OWNER);
    findManagedAccountMock.mockReset().mockResolvedValue(ACCOUNT_ROW);
    countAccountTransactionsMock.mockReset().mockResolvedValue(0);
    updateAccountMock.mockReset().mockResolvedValue(true);
    revalidatePathMock.mockReset();
  });

  it("renames an account and trusts the session for ownership", async () => {
    const result = await updateAccountAction({
      id: ACCOUNT_ROW.id,
      name: "Compte principal",
      type: "CHECKING",
      currency: "EUR",
    });

    expect(result).toEqual({ status: "ok" });
    expect(updateAccountMock).toHaveBeenCalledWith(OWNER.workspace.id, ACCOUNT_ROW.id, {
      name: "Compte principal",
      type: "CHECKING",
      currency: "EUR",
      lowBalanceThreshold: null,
    });
  });

  it("refuses a currency change on an account that already has transactions", async () => {
    countAccountTransactionsMock.mockResolvedValue(3);

    const result = await updateAccountAction({
      id: ACCOUNT_ROW.id,
      name: "Compte courant",
      type: "CHECKING",
      currency: "USD",
    });

    expect(result.status).toBe("invalid");
    expect(result.status === "invalid" && result.message).toMatch(/devise/);
    expect(updateAccountMock).not.toHaveBeenCalled();
  });

  it("allows a currency change while the account is empty", async () => {
    const result = await updateAccountAction({
      id: ACCOUNT_ROW.id,
      name: "Compte courant",
      type: "CHECKING",
      currency: "USD",
    });

    expect(result).toEqual({ status: "ok" });
    expect(updateAccountMock).toHaveBeenCalled();
  });

  it("reports an account that no longer exists", async () => {
    findManagedAccountMock.mockResolvedValue(null);

    const result = await updateAccountAction({
      id: "gone",
      name: "X",
      type: "CHECKING",
      currency: "EUR",
    });

    expect(result.status).toBe("invalid");
    expect(updateAccountMock).not.toHaveBeenCalled();
  });
});

describe("setAccountArchivedAction", () => {
  beforeEach(() => {
    requireUserMock.mockReset().mockResolvedValue(OWNER);
    setAccountArchivedMock.mockReset().mockResolvedValue(true);
    revalidatePathMock.mockReset();
  });

  it("archives the account and explains what changes", async () => {
    const result = await setAccountArchivedAction({ id: "account-1", archived: "true" });

    expect(result.status).toBe("ok");
    expect(result.status === "ok" && result.message).toMatch(/archivé/);
    expect(setAccountArchivedMock).toHaveBeenCalledWith(OWNER.workspace.id, "account-1", true);
  });

  it("restores the account", async () => {
    const result = await setAccountArchivedAction({ id: "account-1", archived: "false" });

    expect(result.status).toBe("ok");
    expect(setAccountArchivedMock).toHaveBeenCalledWith(OWNER.workspace.id, "account-1", false);
  });
});

describe("updateCategoryAction", () => {
  const CATEGORY_ROW = { id: "category-1", name: "Courses", kind: "EXPENSE" as const };

  beforeEach(() => {
    requireUserMock.mockReset().mockResolvedValue(OWNER);
    findCategoryMock.mockReset().mockResolvedValue(CATEGORY_ROW);
    countCategoryReferencesMock
      .mockReset()
      .mockResolvedValue({ transactions: 0, budgets: 0, recurring: 0 });
    updateCategoryMock.mockReset().mockResolvedValue(true);
    revalidatePathMock.mockReset();
  });

  it("renames a category without touching its kind", async () => {
    const result = await updateCategoryAction({
      id: CATEGORY_ROW.id,
      name: "Alimentation",
      kind: "EXPENSE",
    });

    expect(result).toEqual({ status: "ok" });
    expect(updateCategoryMock).toHaveBeenCalledWith(OWNER.workspace.id, CATEGORY_ROW.id, {
      name: "Alimentation",
      kind: "EXPENSE",
    });
  });

  it("refuses a kind change while anything references the category", async () => {
    countCategoryReferencesMock.mockResolvedValue({
      transactions: 12,
      budgets: 2,
      recurring: 1,
    });

    const result = await updateCategoryAction({
      id: CATEGORY_ROW.id,
      name: "Courses",
      kind: "INCOME",
    });

    expect(result.status).toBe("invalid");
    expect(result.status === "invalid" && result.message).toMatch(/Fusionnez/);
    expect(updateCategoryMock).not.toHaveBeenCalled();
  });

  it("allows a kind change on an unused category", async () => {
    const result = await updateCategoryAction({
      id: CATEGORY_ROW.id,
      name: "Courses",
      kind: "INCOME",
    });

    expect(result).toEqual({ status: "ok" });
    expect(updateCategoryMock).toHaveBeenCalled();
  });

  it("translates the unique constraint into a field error", async () => {
    const conflict = Object.assign(new Error("unique"), { code: "P2002" });
    updateCategoryMock.mockRejectedValue(conflict);

    const result = await updateCategoryAction({
      id: CATEGORY_ROW.id,
      name: "Alimentation",
      kind: "EXPENSE",
    });

    expect(result.status).toBe("invalid");
    expect(
      result.status === "invalid" && result.fieldErrors.name?.join(" "),
    ).toMatch(/existe déjà/);
  });
});

describe("mergeCategoriesAction", () => {
  const SOURCE = { id: "category-1", name: "Courses", kind: "EXPENSE" as const };
  const TARGET = { id: "category-2", name: "Alimentation", kind: "EXPENSE" as const };

  beforeEach(() => {
    requireUserMock.mockReset().mockResolvedValue(OWNER);
    findCategoryMock.mockReset().mockImplementation((_userId: string, id: string) =>
      Promise.resolve(id === SOURCE.id ? SOURCE : id === TARGET.id ? TARGET : null),
    );
    mergeCategoriesMock.mockReset().mockResolvedValue({
      movedTransactions: 4,
      movedRecurring: 1,
      movedBudgets: 2,
      droppedBudgets: 1,
    });
    revalidatePathMock.mockReset();
  });

  it("merges same-kind categories and reports every count, dropped budgets included", async () => {
    const result = await mergeCategoriesAction({
      sourceId: SOURCE.id,
      targetId: TARGET.id,
    });

    expect(result.status).toBe("ok");
    expect(result.status === "ok" && result.message).toContain("4 opérations");
    expect(result.status === "ok" && result.message).toMatch(/doublon/);
    expect(mergeCategoriesMock).toHaveBeenCalledWith(OWNER.workspace.id, SOURCE.id, TARGET.id);
  });

  it("refuses a source equal to the target", async () => {
    const result = await mergeCategoriesAction({
      sourceId: SOURCE.id,
      targetId: SOURCE.id,
    });

    expect(result.status).toBe("invalid");
    expect(mergeCategoriesMock).not.toHaveBeenCalled();
  });

  it("refuses merging across kinds: history would move to the wrong side", async () => {
    findCategoryMock.mockImplementation((_userId: string, id: string) =>
      Promise.resolve(
        id === SOURCE.id
          ? SOURCE
          : { id: TARGET.id, name: "Salaire", kind: "INCOME" as const },
      ),
    );

    const result = await mergeCategoriesAction({
      sourceId: SOURCE.id,
      targetId: TARGET.id,
    });

    expect(result.status).toBe("invalid");
    expect(mergeCategoriesMock).not.toHaveBeenCalled();
  });
});

describe("deleteCategoryAction", () => {
  beforeEach(() => {
    requireUserMock.mockReset().mockResolvedValue(OWNER);
    deleteCategoryMock.mockReset().mockResolvedValue(true);
    revalidatePathMock.mockReset();
  });

  it("deletes the category of the signed-in owner", async () => {
    const result = await deleteCategoryAction({ id: "category-1" });

    expect(result).toEqual({ status: "ok" });
    expect(deleteCategoryMock).toHaveBeenCalledWith(OWNER.workspace.id, "category-1");
  });

  it("reports an already deleted category", async () => {
    deleteCategoryMock.mockResolvedValue(false);

    const result = await deleteCategoryAction({ id: "gone" });

    expect(result.status).toBe("invalid");
  });
});

describe("createTransferAction", () => {
  const FROM = {
    id: "account-1",
    name: "Compte courant",
    type: "CHECKING" as const,
    currency: "EUR" as const,
  };
  const TO = {
    id: "account-2",
    name: "Livret A",
    type: "SAVINGS" as const,
    currency: "EUR" as const,
  };

  beforeEach(() => {
    requireUserMock.mockReset().mockResolvedValue(OWNER);
    findAccountMock.mockReset().mockImplementation((_userId: string, id: string) =>
      Promise.resolve(id === FROM.id ? FROM : id === TO.id ? TO : null),
    );
    createTransferGroupMock
      .mockReset()
      .mockResolvedValue({ groupId: "group-1", transactionIds: ["tx-out", "tx-in"] });
    revalidatePathMock.mockReset();
  });

  it("writes both legs with the default labels, in the accounts' currency", async () => {
    const result = await createTransferAction({
      fromAccountId: FROM.id,
      toAccountId: TO.id,
      amount: "300,00",
      operationDate: "2026-10-07",
      label: "",
      notes: "",
    });

    expect(result.status).toBe("ok");
    expect(createTransferGroupMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: OWNER.workspace.id,
        fromAccountId: FROM.id,
        toAccountId: TO.id,
        currency: "EUR",
        sourceLabel: "Virement vers Livret A",
        destinationLabel: "Virement depuis Compte courant",
      }),
    );
    expect(recordAuditEventSafelyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "transaction.transfer",
        entityType: "TRANSFER",
        entityId: "group-1",
        metadata: { currency: "EUR", legs: 2 },
      }),
    );
  });

  it("keeps a custom label on both legs", async () => {
    await createTransferAction({
      fromAccountId: FROM.id,
      toAccountId: TO.id,
      amount: "50",
      operationDate: "2026-10-07",
      label: "Épargne octobre",
      notes: "",
    });

    const [input] = createTransferGroupMock.mock.calls[0] as [
      { sourceLabel: string; destinationLabel: string },
    ];
    expect(input.sourceLabel).toBe("Épargne octobre");
    expect(input.destinationLabel).toBe("Épargne octobre");
  });

  it("refuses a cross-currency transfer instead of converting", async () => {
    findAccountMock.mockImplementation((_userId: string, id: string) =>
      Promise.resolve(id === FROM.id ? FROM : { ...TO, currency: "USD" as const }),
    );

    const result = await createTransferAction({
      fromAccountId: FROM.id,
      toAccountId: TO.id,
      amount: "300,00",
      operationDate: "2026-10-07",
      label: "",
      notes: "",
    });

    expect(result.status).toBe("invalid");
    expect(result.status === "invalid" && result.message).toMatch(/conversion/);
    expect(createTransferGroupMock).not.toHaveBeenCalled();
  });

  it("refuses the same account twice before reading anything", async () => {
    const result = await createTransferAction({
      fromAccountId: FROM.id,
      toAccountId: FROM.id,
      amount: "300,00",
      operationDate: "2026-10-07",
      label: "",
      notes: "",
    });

    expect(result.status).toBe("invalid");
    expect(createTransferGroupMock).not.toHaveBeenCalled();
  });

  it("refuses a zero or negative amount before reading anything", async () => {
    const result = await createTransferAction({
      fromAccountId: FROM.id,
      toAccountId: TO.id,
      amount: "0",
      operationDate: "2026-10-07",
      label: "",
      notes: "",
    });

    expect(result.status).toBe("invalid");
    expect(createTransferGroupMock).not.toHaveBeenCalled();
  });
});

describe("setTransactionReconciledAction", () => {
  beforeEach(() => {
    requireUserMock.mockReset().mockResolvedValue(OWNER);
    setTransactionReconciledMock.mockReset().mockResolvedValue(true);
    revalidatePathMock.mockReset();
  });

  it("ticks one transaction, owner from the session", async () => {
    const result = await setTransactionReconciledAction({ id: "tx-1", reconciled: "true" });

    expect(result).toEqual({ status: "ok" });
    expect(setTransactionReconciledMock).toHaveBeenCalledWith({
      workspaceId: OWNER.workspace.id,
      transactionId: "tx-1",
      reconciled: true,
    });
    expect(recordAuditEventSafelyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "transaction.reconcile",
        entityId: "tx-1",
        metadata: { reconciled: true },
      }),
    );
  });

  it("unticks it too", async () => {
    await setTransactionReconciledAction({ id: "tx-1", reconciled: "false" });

    expect(setTransactionReconciledMock).toHaveBeenCalledWith({
      workspaceId: OWNER.workspace.id,
      transactionId: "tx-1",
      reconciled: false,
    });
  });

  it("reports a missing transaction", async () => {
    setTransactionReconciledMock.mockResolvedValue(false);

    const result = await setTransactionReconciledAction({ id: "gone", reconciled: "true" });

    expect(result.status).toBe("invalid");
  });
});

describe("copyBudgetsAction", () => {
  beforeEach(() => {
    requireUserMock.mockReset().mockResolvedValue(OWNER);
    revalidatePathMock.mockReset();
  });

  it("copies the previous month onto the displayed one and reports both counts", async () => {
    copyBudgetsMock.mockReset().mockResolvedValue({ created: 5, skipped: 2 });

    const result = await copyBudgetsAction({ month: "2026-11" });

    expect(result.status).toBe("ok");
    expect(result.status === "ok" && result.message).toContain("5 budgets");
    expect(result.status === "ok" && result.message).toMatch(/2 déjà présents/);
    // October is the previous month of November: the shift crosses no year here.
    expect(copyBudgetsMock).toHaveBeenCalledWith({
      workspaceId: OWNER.workspace.id,
      from: { year: 2026, month: 10 },
      to: { year: 2026, month: 11 },
    });
  });

  it("crosses the year boundary for January", async () => {
    copyBudgetsMock.mockResolvedValue({ created: 1, skipped: 0 });

    await copyBudgetsAction({ month: "2027-01" });

    expect(copyBudgetsMock).toHaveBeenCalledWith({
      workspaceId: OWNER.workspace.id,
      from: { year: 2026, month: 12 },
      to: { year: 2027, month: 1 },
    });
  });

  it("answers an empty source month plainly, not as an error", async () => {
    copyBudgetsMock.mockResolvedValue({ created: 0, skipped: 0 });

    const result = await copyBudgetsAction({ month: "2026-11" });

    expect(result.status).toBe("ok");
    expect(result.status === "ok" && result.message).toMatch(/aucun budget/);
  });
});
