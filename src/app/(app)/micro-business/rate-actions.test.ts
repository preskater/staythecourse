import Decimal from "decimal.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const requireModuleMock = vi.fn();
const revalidatePathMock = vi.fn();
const recordAuditEventSafelyMock = vi.fn();
const upsertBillingRateMock = vi.fn();
const upsertInternalCostRateMock = vi.fn();

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
  upsertBillingRate: (...args: unknown[]) => upsertBillingRateMock(...args),
  upsertInternalCostRate: (...args: unknown[]) => upsertInternalCostRateMock(...args),
}));

const { saveBillingRateAction, saveInternalCostRateAction } = await import(
  "./rate-actions"
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

const billingPayload = {
  clientId: "client-1",
  month: "2026-03",
  hourlyRate: "85,00",
  currency: "EUR",
};

const internalPayload = {
  month: "2026-03",
  hourlyRate: "48,50",
  currency: "EUR",
};

beforeEach(() => {
  vi.clearAllMocks();
  requireModuleMock.mockResolvedValue(sessionAs("OWNER"));
  upsertBillingRateMock.mockResolvedValue({
    id: "billing-rate-1",
    clientId: "client-1",
    clientName: "Studio Lumen",
    year: 2026,
    month: 3,
    hourlyRate: new Decimal("85.00"),
    currency: "EUR",
  });
  upsertInternalCostRateMock.mockResolvedValue({
    id: "internal-rate-1",
    year: 2026,
    month: 3,
    hourlyRate: new Decimal("48.50"),
    currency: "EUR",
  });
});

describe("saveBillingRateAction", () => {
  it("saves a change point for the parsed month and audits it", async () => {
    const result = await saveBillingRateAction(billingPayload);

    expect(result.status).toBe("ok");
    expect(upsertBillingRateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-user-1",
        clientId: "client-1",
        year: 2026,
        month: 3,
        currency: "EUR",
      }),
    );
    const saved = upsertBillingRateMock.mock.calls[0][0];
    expect(saved.hourlyRate.toFixed(2)).toBe("85.00");
    expect(recordAuditEventSafelyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "rate.billing_write",
        entityType: "BILLING_RATE",
      }),
    );
  });

  it("refuses a foreign client and writes no rate", async () => {
    upsertBillingRateMock.mockResolvedValue(null);

    const result = await saveBillingRateAction(billingPayload);

    expect(result.status).toBe("invalid");
    expect(result.status === "invalid" && result.message).toContain("introuvable");
    expect(recordAuditEventSafelyMock).not.toHaveBeenCalled();
  });

  it("refuses a member who may read but not write", async () => {
    requireModuleMock.mockResolvedValue(sessionAs("MEMBER"));

    const result = await saveBillingRateAction(billingPayload);

    expect(result.status).toBe("error");
    expect(upsertBillingRateMock).not.toHaveBeenCalled();
  });

  it("refuses a malformed month before reaching the repository", async () => {
    const result = await saveBillingRateAction({ ...billingPayload, month: "2026-13" });

    expect(result.status).toBe("invalid");
    expect(upsertBillingRateMock).not.toHaveBeenCalled();
  });
});

describe("saveInternalCostRateAction", () => {
  it("lets the owner save a confidential rate", async () => {
    const result = await saveInternalCostRateAction(internalPayload);

    expect(result.status).toBe("ok");
    expect(upsertInternalCostRateMock).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-user-1", year: 2026, month: 3 }),
    );
    expect(recordAuditEventSafelyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "rate.internal_write",
        entityType: "INTERNAL_COST_RATE",
      }),
    );
  });

  it("refuses an admin without the internal-rates permission and reads nothing", async () => {
    requireModuleMock.mockResolvedValue(sessionAs("ADMIN"));

    const result = await saveInternalCostRateAction(internalPayload);

    expect(result.status).toBe("error");
    expect(result.status === "error" && result.message).toContain("confidentiels");
    expect(upsertInternalCostRateMock).not.toHaveBeenCalled();
    expect(recordAuditEventSafelyMock).not.toHaveBeenCalled();
  });

  it("refuses a member before any internal figure is touched", async () => {
    requireModuleMock.mockResolvedValue(sessionAs("MEMBER"));

    const result = await saveInternalCostRateAction(internalPayload);

    expect(result.status).toBe("error");
    expect(upsertInternalCostRateMock).not.toHaveBeenCalled();
  });
});
