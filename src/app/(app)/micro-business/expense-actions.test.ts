import { beforeEach, describe, expect, it, vi } from "vitest";

const requireModuleMock = vi.fn();
const revalidatePathMock = vi.fn();
const recordAuditEventSafelyMock = vi.fn();
const createBusinessExpenseMock = vi.fn();
const deleteBusinessExpenseMock = vi.fn();

vi.mock("@/lib/auth/guard", () => ({
  requireModule: (...args: unknown[]) => requireModuleMock(...args),
}));
vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => revalidatePathMock(...args),
}));
vi.mock("@/modules/audit/repository", () => ({
  recordAuditEventSafely: (...args: unknown[]) => recordAuditEventSafelyMock(...args),
}));
vi.mock("@/modules/micro-business/repository", () => ({
  createBusinessExpense: (...args: unknown[]) => createBusinessExpenseMock(...args),
  deleteBusinessExpense: (...args: unknown[]) => deleteBusinessExpenseMock(...args),
}));

const { createBusinessExpenseAction, deleteBusinessExpenseAction } = await import(
  "./expense-actions"
);

/** Fictitious session; the workspace always comes from it, never from the request. */
function sessionAs(role: string) {
  return {
    id: "user-1",
    email: "owner@example.test",
    name: null,
    sessionId: "session-1",
    workspace: {
      id: "ws-user-1",
      name: "Entreprise",
      kind: "COMPANY",
      role,
      modules: ["micro-business"],
    },
  };
}

const payload = {
  label: "Assurance RC",
  vendor: "Mutuelle",
  kind: "OBLIGATION",
  amount: "120,00",
  currency: "EUR",
  frequency: "YEARLY",
  startDate: "2026-03-10",
  endDate: "",
  notes: "",
};

beforeEach(() => {
  vi.clearAllMocks();
  requireModuleMock.mockResolvedValue(sessionAs("OWNER"));
  createBusinessExpenseMock.mockResolvedValue({ id: "expense-1" });
  deleteBusinessExpenseMock.mockResolvedValue(true);
});

describe("createBusinessExpenseAction", () => {
  it("records the definition with parsed values and audits it", async () => {
    const result = await createBusinessExpenseAction(payload);

    expect(result.status).toBe("ok");
    expect(createBusinessExpenseMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-user-1",
        label: "Assurance RC",
        vendor: "Mutuelle",
        kind: "OBLIGATION",
        currency: "EUR",
        frequency: "YEARLY",
        endDate: null,
      }),
    );
    const saved = createBusinessExpenseMock.mock.calls[0][0];
    expect(saved.amount.toFixed(2)).toBe("120.00");
    expect(recordAuditEventSafelyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "business_expense.create",
        entityType: "BUSINESS_EXPENSE",
      }),
    );
  });

  it("refuses a member who may read but not write", async () => {
    requireModuleMock.mockResolvedValue(sessionAs("MEMBER"));

    const result = await createBusinessExpenseAction(payload);

    expect(result.status).toBe("error");
    expect(createBusinessExpenseMock).not.toHaveBeenCalled();
  });

  it("refuses a non-positive amount before writing", async () => {
    const result = await createBusinessExpenseAction({ ...payload, amount: "0" });

    expect(result.status).toBe("invalid");
    expect(createBusinessExpenseMock).not.toHaveBeenCalled();
  });

  it("refuses an end date before the start date", async () => {
    const result = await createBusinessExpenseAction({ ...payload, endDate: "2026-03-09" });

    expect(result.status).toBe("invalid");
    expect(createBusinessExpenseMock).not.toHaveBeenCalled();
  });
});

describe("deleteBusinessExpenseAction", () => {
  it("deletes a definition and audits it", async () => {
    const result = await deleteBusinessExpenseAction({ id: "expense-1" });

    expect(result.status).toBe("ok");
    expect(deleteBusinessExpenseMock).toHaveBeenCalledWith("ws-user-1", "expense-1");
    expect(recordAuditEventSafelyMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "business_expense.delete" }),
    );
  });

  it("refuses an unknown or foreign definition", async () => {
    deleteBusinessExpenseMock.mockResolvedValue(false);

    const result = await deleteBusinessExpenseAction({ id: "expense-1" });

    expect(result.status).toBe("invalid");
    expect(recordAuditEventSafelyMock).not.toHaveBeenCalled();
  });

  it("refuses a member before touching the repository", async () => {
    requireModuleMock.mockResolvedValue(sessionAs("MEMBER"));

    const result = await deleteBusinessExpenseAction({ id: "expense-1" });

    expect(result.status).toBe("error");
    expect(deleteBusinessExpenseMock).not.toHaveBeenCalled();
  });
});
