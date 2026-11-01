import Decimal from "decimal.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const requireUserMock = vi.fn();
const findAccountMock = vi.fn();
const findCategoryMock = vi.fn();
const findRecurringEntryMock = vi.fn();
const findRecurringOccurrenceMock = vi.fn();
const countDecidedOccurrencesMock = vi.fn();
const createRecurringEntryMock = vi.fn();
const deleteRecurringEntryMock = vi.fn();
const createTransactionMock = vi.fn();
const decideRecurringOccurrenceMock = vi.fn();
const revalidatePathMock = vi.fn();
const recordAuditEventSafelyMock = vi.fn();

vi.mock("@/lib/auth/guard", () => ({ requireModule: (key: string) => requireUserMock(key) }));
vi.mock("@/modules/audit/repository", () => ({
  recordAuditEventSafely: (...args: unknown[]) => recordAuditEventSafelyMock(...args),
}));
vi.mock("@/modules/budget/repository", () => ({
  findAccount: (...args: unknown[]) => findAccountMock(...args),
  findCategory: (...args: unknown[]) => findCategoryMock(...args),
  findRecurringEntry: (...args: unknown[]) => findRecurringEntryMock(...args),
  findRecurringOccurrence: (...args: unknown[]) => findRecurringOccurrenceMock(...args),
  countDecidedOccurrences: (...args: unknown[]) => countDecidedOccurrencesMock(...args),
  createRecurringEntry: (...args: unknown[]) => createRecurringEntryMock(...args),
  deleteRecurringEntry: (...args: unknown[]) => deleteRecurringEntryMock(...args),
  createTransaction: (...args: unknown[]) => createTransactionMock(...args),
  decideRecurringOccurrence: (...args: unknown[]) => decideRecurringOccurrenceMock(...args),
}));
vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => revalidatePathMock(...args),
}));

const {
  confirmRecurringOccurrenceAction,
  createRecurringEntryAction,
  deleteRecurringEntryAction,
  dismissRecurringOccurrenceAction,
  skipRecurringOccurrenceAction,
} = await import("./forecast-actions");

/**
 * Fictitious data only. The actions decide alone whether a write is allowed, so they
 * are tested against mocked repositories: no test touches a database. The confirmation
 * goes through the real `resolveTransactionInput` module, which reads the mocked
 * account and category lookups — that is what makes these tests cover the shared
 * ownership rules rather than a parallel copy of them.
 */
const OWNER = {
  id: "owner-1",
  email: "owner@example.test",
  name: null,
  workspace: { id: "ws-owner-1", modules: ["budget", "real-estate", "development"] },
};

const ACCOUNT = { id: "account-1", name: "Compte courant", type: "CHECKING", currency: "EUR" };
const EXPENSE_CATEGORY = { id: "category-1", name: "Logement", kind: "EXPENSE" };

const OCCURRENCE_DATE = new Date(Date.UTC(2026, 9, 5));

const OCCURRENCE = {
  id: "occ-1",
  recurringId: "entry-1",
  date: OCCURRENCE_DATE,
  status: "PENDING",
  transactionId: null,
  decidedAt: null,
};

const ENTRY = {
  id: "entry-1",
  accountId: "account-1",
  accountName: "Compte courant",
  categoryId: "category-1",
  categoryName: "Logement",
  type: "EXPENSE",
  label: "Loyer",
  amount: new Decimal("950"),
  frequency: "MONTHLY",
  startDate: new Date(Date.UTC(2026, 0, 5)),
  endDate: null,
};

const VALID_PAYLOAD = {
  accountId: "account-1",
  categoryId: "category-1",
  type: "EXPENSE",
  label: "Loyer",
  amount: "950,00",
  frequency: "MONTHLY",
  startDate: "2026-10-05",
  endDate: "",
};

beforeEach(() => {
  requireUserMock.mockReset().mockResolvedValue(OWNER);
  findAccountMock.mockReset().mockResolvedValue(ACCOUNT);
  findCategoryMock.mockReset().mockResolvedValue(EXPENSE_CATEGORY);
  findRecurringEntryMock.mockReset().mockResolvedValue(ENTRY);
  findRecurringOccurrenceMock.mockReset().mockResolvedValue(OCCURRENCE);
  countDecidedOccurrencesMock.mockReset().mockResolvedValue(0);
  createRecurringEntryMock.mockReset().mockResolvedValue({ id: "entry-1" });
  deleteRecurringEntryMock.mockReset().mockResolvedValue(true);
  createTransactionMock.mockReset().mockResolvedValue({ id: "tx-1" });
  decideRecurringOccurrenceMock.mockReset().mockResolvedValue(true);
  revalidatePathMock.mockReset();
  recordAuditEventSafelyMock.mockReset();
});

describe("confirmRecurringOccurrenceAction", () => {
  it("creates the transaction through the manual path, dated on the occurrence day", async () => {
    const result = await confirmRecurringOccurrenceAction({ id: "occ-1" });

    expect(result).toEqual({ status: "ok" });

    expect(createTransactionMock).toHaveBeenCalledTimes(1);
    const written = createTransactionMock.mock.calls[0][0] as {
      workspaceId: string;
      accountId: string;
      categoryId: string;
      type: string;
      label: string;
      amount: Decimal;
      currency: string;
      operationDate: Date;
      externalRef: string;
    };

    expect(written.workspaceId).toBe(OWNER.workspace.id);
    expect(written.accountId).toBe("account-1");
    expect(written.categoryId).toBe("category-1");
    expect(written.type).toBe("EXPENSE");
    expect(written.label).toBe("Loyer");
    // The magnitude is stored positive on the series; the sign is the type's business.
    expect(written.amount.toFixed(2)).toBe("-950.00");
    // The currency comes from the account — no conversion, nothing asked to the browser.
    expect(written.currency).toBe("EUR");
    // The échéance is the fact being recorded, not the day of the click.
    expect(written.operationDate).toBe(OCCURRENCE_DATE);
    // Stable reference: the unique (account, reference) refuses a double booking.
    expect(written.externalRef).toBe("forecast:occ-1");

    expect(decideRecurringOccurrenceMock).toHaveBeenCalledWith(OWNER.workspace.id, "occ-1", {
      status: "CONFIRMED",
      transactionId: "tx-1",
    });
    expect(revalidatePathMock).toHaveBeenCalledWith("/budget");
    expect(revalidatePathMock).toHaveBeenCalledWith("/dashboard");

    const [audit] = recordAuditEventSafelyMock.mock.calls[0] as [Record<string, unknown>];
    expect(audit).toMatchObject({
      action: "transaction.create",
      entityType: "TRANSACTION",
      entityId: "tx-1",
      metadata: { type: "EXPENSE", currency: "EUR", source: "forecast" },
    });
    expect(JSON.stringify(audit)).not.toContain("Loyer");
    expect(JSON.stringify(audit)).not.toContain("950");
  });

  it("refuses a category of the wrong kind, without writing anything", async () => {
    // An income category on an expected expense: the rule every manual write obeys.
    findCategoryMock.mockResolvedValue({ id: "category-1", name: "Salaire", kind: "INCOME" });

    const result = await confirmRecurringOccurrenceAction({ id: "occ-1" });

    expect(result.status).toBe("invalid");
    expect(result.status === "invalid" && result.message).toMatch(/catégorie/);
    expect(createTransactionMock).not.toHaveBeenCalled();
    expect(decideRecurringOccurrenceMock).not.toHaveBeenCalled();
  });

  it("refuses an account that does not belong to the owner", async () => {
    findAccountMock.mockResolvedValue(null);

    const result = await confirmRecurringOccurrenceAction({ id: "occ-1" });

    expect(result.status).toBe("invalid");
    expect(result.status === "invalid" && result.message).toMatch(/Compte introuvable/);
    expect(createTransactionMock).not.toHaveBeenCalled();
  });

  it("refuses an occurrence that already carries a decision", async () => {
    findRecurringOccurrenceMock.mockResolvedValue({
      ...OCCURRENCE,
      status: "SKIPPED",
      decidedAt: new Date(),
    });

    const result = await confirmRecurringOccurrenceAction({ id: "occ-1" });

    expect(result.status).toBe("invalid");
    expect(result.status === "invalid" && result.message).toMatch(/déjà passée/);
    expect(createTransactionMock).not.toHaveBeenCalled();
  });

  it("reports an unknown occurrence instead of pretending", async () => {
    findRecurringOccurrenceMock.mockResolvedValue(null);

    const result = await confirmRecurringOccurrenceAction({ id: "occ-gone" });

    expect(result.status).toBe("invalid");
    expect(result.status === "invalid" && result.message).toMatch(/introuvable/);
    expect(createTransactionMock).not.toHaveBeenCalled();
  });

  it("answers a duplicate confirmation with the audit message", async () => {
    // Two clicks crossed: the unique (account, externalRef) refused the second write.
    createTransactionMock.mockRejectedValue({ code: "P2002" });

    const result = await confirmRecurringOccurrenceAction({ id: "occ-1" });

    expect(result.status).toBe("invalid");
    expect(result.status === "invalid" && result.message).toMatch(/déjà confirmée/);
    expect(decideRecurringOccurrenceMock).not.toHaveBeenCalled();
  });
});

describe("skipRecurringOccurrenceAction", () => {
  it("records the decision and creates no transaction", async () => {
    const result = await skipRecurringOccurrenceAction({ id: "occ-1" });

    expect(result).toEqual({ status: "ok" });
    expect(decideRecurringOccurrenceMock).toHaveBeenCalledWith(OWNER.workspace.id, "occ-1", {
      status: "SKIPPED",
    });
    // The whole point of a forecast: passing it writes a decision, never a line.
    expect(createTransactionMock).not.toHaveBeenCalled();
    expect(revalidatePathMock).toHaveBeenCalledWith("/budget");
  });

  it("refuses an occurrence that already carries a decision", async () => {
    findRecurringOccurrenceMock.mockResolvedValue({ ...OCCURRENCE, status: "CONFIRMED" });

    const result = await skipRecurringOccurrenceAction({ id: "occ-1" });

    expect(result.status).toBe("invalid");
    expect(decideRecurringOccurrenceMock).not.toHaveBeenCalled();
  });
});

describe("dismissRecurringOccurrenceAction", () => {
  it("records the decision and creates no transaction", async () => {
    const result = await dismissRecurringOccurrenceAction({ id: "occ-1" });

    expect(result).toEqual({ status: "ok" });
    expect(decideRecurringOccurrenceMock).toHaveBeenCalledWith(OWNER.workspace.id, "occ-1", {
      status: "DISMISSED",
    });
    expect(createTransactionMock).not.toHaveBeenCalled();
  });

  it("reports a decision that lost a race instead of overwriting it", async () => {
    decideRecurringOccurrenceMock.mockResolvedValue(false);

    const result = await dismissRecurringOccurrenceAction({ id: "occ-1" });

    expect(result.status).toBe("invalid");
    expect(result.status === "invalid" && result.message).toMatch(/entre-temps/);
  });
});

describe("createRecurringEntryAction", () => {
  it("stores the series with the owner's own account and category", async () => {
    const result = await createRecurringEntryAction(VALID_PAYLOAD);

    expect(result).toEqual({ status: "ok" });
    expect(createRecurringEntryMock).toHaveBeenCalledTimes(1);

    const written = createRecurringEntryMock.mock.calls[0][0] as {
      workspaceId: string;
      accountId: string;
      categoryId: string;
      type: string;
      amount: Decimal;
      frequency: string;
      startDate: Date;
      endDate: Date | null;
    };

    expect(written.workspaceId).toBe(OWNER.workspace.id);
    expect(written.accountId).toBe("account-1");
    expect(written.categoryId).toBe("category-1");
    expect(written.type).toBe("EXPENSE");
    // Stored as a positive magnitude, like a budget.
    expect(written.amount.toFixed(2)).toBe("950.00");
    expect(written.frequency).toBe("MONTHLY");
    expect(written.endDate).toBeNull();
  });

  it("refuses a category of the wrong kind", async () => {
    findCategoryMock.mockResolvedValue({ id: "category-1", name: "Salaire", kind: "INCOME" });

    const result = await createRecurringEntryAction(VALID_PAYLOAD);

    expect(result.status).toBe("invalid");
    expect(createRecurringEntryMock).not.toHaveBeenCalled();
  });

  it("refuses an account that does not belong to the owner", async () => {
    findAccountMock.mockResolvedValue(null);

    const result = await createRecurringEntryAction(VALID_PAYLOAD);

    expect(result.status).toBe("invalid");
    expect(createRecurringEntryMock).not.toHaveBeenCalled();
  });

  it("refuses an end date before the start date", async () => {
    const result = await createRecurringEntryAction({
      ...VALID_PAYLOAD,
      endDate: "2026-09-05",
    });

    expect(result.status).toBe("invalid");
    expect(createRecurringEntryMock).not.toHaveBeenCalled();
  });

  it("refuses a non-positive amount", async () => {
    const result = await createRecurringEntryAction({ ...VALID_PAYLOAD, amount: "0" });

    expect(result.status).toBe("invalid");
    expect(createRecurringEntryMock).not.toHaveBeenCalled();
  });
});

describe("deleteRecurringEntryAction", () => {
  it("deletes a series that carries no decision yet", async () => {
    const result = await deleteRecurringEntryAction({ id: "entry-1" });

    expect(result).toEqual({ status: "ok" });
    expect(deleteRecurringEntryMock).toHaveBeenCalledWith(OWNER.workspace.id, "entry-1");
    expect(revalidatePathMock).toHaveBeenCalledWith("/budget");
  });

  it("refuses to delete a series that already carries a decided occurrence", async () => {
    countDecidedOccurrencesMock.mockResolvedValue(2);

    const result = await deleteRecurringEntryAction({ id: "entry-1" });

    expect(result.status).toBe("invalid");
    expect(result.status === "invalid" && result.message).toMatch(/audit/);
    // Skipped and dismissed échéances are the audit trail: they outlive the series.
    expect(deleteRecurringEntryMock).not.toHaveBeenCalled();
  });

  it("reports an unknown or already deleted series instead of pretending", async () => {
    deleteRecurringEntryMock.mockResolvedValue(false);

    const result = await deleteRecurringEntryAction({ id: "entry-gone" });

    expect(result.status).toBe("invalid");
    expect(result.status === "invalid" && result.message).toMatch(/introuvable/);
  });
});
