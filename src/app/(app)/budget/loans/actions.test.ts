import { beforeEach, describe, expect, it, vi } from "vitest";

const requireModuleMock = vi.fn();
const findLoanMock = vi.fn();
const createLoanMock = vi.fn();
const updateLoanMock = vi.fn();
const setLoanArchivedMock = vi.fn();
const findPropertyMock = vi.fn();
const revalidatePathMock = vi.fn();
const recordAuditEventSafelyMock = vi.fn();

vi.mock("@/lib/auth/guard", () => ({
  requireModule: (...args: unknown[]) => requireModuleMock(...args),
}));
vi.mock("@/modules/loans/repository", () => ({
  findLoan: (...args: unknown[]) => findLoanMock(...args),
  createLoan: (...args: unknown[]) => createLoanMock(...args),
  updateLoan: (...args: unknown[]) => updateLoanMock(...args),
  setLoanArchived: (...args: unknown[]) => setLoanArchivedMock(...args),
  listLoans: vi.fn(),
  listSelectableLoans: vi.fn(),
}));
vi.mock("@/modules/real-estate/repository", () => ({
  findProperty: (...args: unknown[]) => findPropertyMock(...args),
}));
vi.mock("@/modules/audit/repository", () => ({
  recordAuditEventSafely: (...args: unknown[]) => recordAuditEventSafelyMock(...args),
}));
vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => revalidatePathMock(...args),
}));

const {
  archiveLoanAction,
  createLoanAction,
  restoreLoanAction,
  updateLoanAction,
} = await import("./actions");

/** A fictitious session; the workspace and its modules always come from here. */
function session(modules: string[] = ["budget", "real-estate"]) {
  return {
    id: "user-1",
    email: "owner@example.test",
    name: null,
    sessionId: "session-1",
    workspace: {
      id: "ws-1",
      name: "Personnel",
      kind: "PERSONAL",
      role: "OWNER",
      modules,
    },
  };
}

/** Fictitious loan values only, exactly as the client form submits them. */
const VALID = {
  label: "Prêt auto de test",
  lender: "Banque de test",
  notes: "",
  purpose: "VEHICLE",
  currency: "EUR",
  initialPrincipal: "25 000,00",
  annualRate: "3,45 %",
  termMonths: "60",
  startDate: "2026-01-01",
  firstDueDate: "2026-02-05",
  paymentDay: "",
  interestOnlyMonths: "0",
  insuranceMode: "FIXED_MONTHLY",
  insuranceMonthlyAmount: "25,00",
  insuranceRate: "",
  fees: "250,00",
  propertyId: "",
  outstandingBalance: "20 000,00",
  balanceAsOf: "2026-10-01",
};

beforeEach(() => {
  vi.clearAllMocks();
  requireModuleMock.mockResolvedValue(session());
  createLoanMock.mockResolvedValue({ id: "loan-1" });
  updateLoanMock.mockResolvedValue(true);
  setLoanArchivedMock.mockResolvedValue(true);
  findPropertyMock.mockResolvedValue({ id: "property-1", name: "Bien de test" });
  findLoanMock.mockResolvedValue({ id: "loan-1", propertyId: null });
});

describe("createLoanAction", () => {
  it("writes an exact loan for the session's workspace and audits codes only", async () => {
    const result = await createLoanAction(VALID);

    expect(result.status).toBe("ok");
    expect(createLoanMock).toHaveBeenCalledTimes(1);

    const input = createLoanMock.mock.calls[0][0] as Record<string, unknown> & {
      initialPrincipal: { toFixed: (digits: number) => string };
      annualRate: { toFixed: (digits: number) => string };
      insuranceMonthlyAmount: { toFixed: (digits: number) => string };
    };

    expect(input).toMatchObject({
      workspaceId: "ws-1",
      userId: "user-1",
      purpose: "VEHICLE",
      currency: "EUR",
      paymentDay: 5,
      propertyId: null,
      insuranceMode: "FIXED_MONTHLY",
      insuranceRate: null,
    });
    expect(input.initialPrincipal.toFixed(2)).toBe("25000.00");
    expect(input.annualRate.toFixed(4)).toBe("3.4500");
    expect(input.insuranceMonthlyAmount.toFixed(2)).toBe("25.00");

    const audit = recordAuditEventSafelyMock.mock.calls[0][0] as {
      action: string;
      entityType: string;
      entityId: string;
      metadata: Record<string, unknown>;
    };
    expect(audit).toMatchObject({
      action: "loan.create",
      entityType: "LOAN",
      entityId: "loan-1",
    });
    expect(audit.metadata).toEqual({
      purpose: "VEHICLE",
      currency: "EUR",
      insuranceMode: "FIXED_MONTHLY",
    });
    expect(JSON.stringify(audit.metadata)).not.toMatch(/25000|Banque|Prêt auto/);
  });

  it("refuses an invalid payload before any lookup or write", async () => {
    const result = await createLoanAction({ ...VALID, initialPrincipal: "-5" });

    expect(result.status).toBe("invalid");
    expect(createLoanMock).not.toHaveBeenCalled();
    expect(recordAuditEventSafelyMock).not.toHaveBeenCalled();
  });

  it("checks the session before touching anything", async () => {
    requireModuleMock.mockRejectedValue(new Error("redirect:/login"));

    await expect(createLoanAction(VALID)).rejects.toThrow("redirect:/login");
    expect(createLoanMock).not.toHaveBeenCalled();
  });

  it("is refused without the budget entitlement", async () => {
    requireModuleMock.mockRejectedValue(new Error("not-found"));

    await expect(createLoanAction(VALID)).rejects.toThrow("not-found");
    expect(requireModuleMock).toHaveBeenCalledWith("budget", "write");
    expect(createLoanMock).not.toHaveBeenCalled();
  });

  it("refuses to link a property when the real-estate module is inactive", async () => {
    requireModuleMock.mockResolvedValue(session(["budget"]));

    const result = await createLoanAction({ ...VALID, propertyId: "property-1" });

    expect(result.status).toBe("invalid");
    expect(result.status === "invalid" && result.fieldErrors.propertyId?.[0]).toMatch(
      /Immobilier/,
    );
    expect(findPropertyMock).not.toHaveBeenCalled();
    expect(createLoanMock).not.toHaveBeenCalled();
    expect(recordAuditEventSafelyMock).not.toHaveBeenCalled();
  });

  it("links a property re-read from the session's workspace", async () => {
    const result = await createLoanAction({ ...VALID, propertyId: "property-1" });

    expect(result.status).toBe("ok");
    expect(findPropertyMock).toHaveBeenCalledWith("ws-1", "property-1");
    expect(createLoanMock.mock.calls[0][0]).toMatchObject({ propertyId: "property-1" });
  });

  it("refuses a property from another workspace", async () => {
    findPropertyMock.mockResolvedValue(null);

    const result = await createLoanAction({ ...VALID, propertyId: "property-foreign" });

    expect(result.status).toBe("invalid");
    expect(result.status === "invalid" && result.message).toMatch(/introuvable/i);
    expect(createLoanMock).not.toHaveBeenCalled();
  });
});

describe("updateLoanAction", () => {
  it("re-reads the loan with the workspace scope and updates it", async () => {
    const result = await updateLoanAction({ ...VALID, id: "loan-1" });

    expect(result.status).toBe("ok");
    expect(findLoanMock).toHaveBeenCalledWith("ws-1", "loan-1");
    expect(updateLoanMock).toHaveBeenCalledTimes(1);
    expect(updateLoanMock.mock.calls[0][0]).toBe("ws-1");
    expect(updateLoanMock.mock.calls[0][1]).toBe("loan-1");
    expect(recordAuditEventSafelyMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "loan.update", entityId: "loan-1" }),
    );
  });

  it("refuses a foreign or unknown loan and writes nothing", async () => {
    findLoanMock.mockResolvedValue(null);

    const result = await updateLoanAction({ ...VALID, id: "loan-foreign" });

    expect(result.status).toBe("invalid");
    expect(result.status === "invalid" && result.message).toMatch(/introuvable/i);
    expect(updateLoanMock).not.toHaveBeenCalled();
    expect(recordAuditEventSafelyMock).not.toHaveBeenCalled();
  });

  it("keeps an existing property link even when the real-estate module is inactive", async () => {
    requireModuleMock.mockResolvedValue(session(["budget"]));
    findLoanMock.mockResolvedValue({ id: "loan-1", propertyId: "property-1" });

    const result = await updateLoanAction({
      ...VALID,
      id: "loan-1",
      propertyId: "property-1",
    });

    expect(result.status).toBe("ok");
    expect(findPropertyMock).toHaveBeenCalledWith("ws-1", "property-1");
    expect(updateLoanMock).toHaveBeenCalledTimes(1);
  });
});

describe("loan archive and restore", () => {
  it("archives with one audit row that carries no amount", async () => {
    const result = await archiveLoanAction({ id: "loan-1" });

    expect(result.status).toBe("ok");
    expect(setLoanArchivedMock).toHaveBeenCalledWith("ws-1", "loan-1", true);

    const audit = recordAuditEventSafelyMock.mock.calls[0][0] as {
      action: string;
      entityType: string;
      entityId: string;
      metadata?: Record<string, unknown>;
    };
    expect(audit).toMatchObject({
      action: "loan.archive",
      entityType: "LOAN",
      entityId: "loan-1",
    });
    expect(audit.metadata).toBeUndefined();
  });

  it("restores the loan and records it", async () => {
    const result = await restoreLoanAction({ id: "loan-1" });

    expect(result.status).toBe("ok");
    expect(setLoanArchivedMock).toHaveBeenCalledWith("ws-1", "loan-1", false);
    expect(recordAuditEventSafelyMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "loan.restore", entityId: "loan-1" }),
    );
  });

  it("refuses a foreign loan and audits nothing", async () => {
    setLoanArchivedMock.mockResolvedValue(false);

    const result = await archiveLoanAction({ id: "loan-foreign" });

    expect(result.status).toBe("invalid");
    expect(result.status === "invalid" && result.message).toMatch(/introuvable/i);
    expect(recordAuditEventSafelyMock).not.toHaveBeenCalled();
  });
});
