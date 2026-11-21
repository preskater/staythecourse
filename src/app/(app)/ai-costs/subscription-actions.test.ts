import { beforeEach, describe, expect, it, vi } from "vitest";

const requireModuleMock = vi.fn();
const createMock = vi.fn();
const cancelMock = vi.fn();
const bookMock = vi.fn();
const recordAuditMock = vi.fn();

class InvalidSubscriptionError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
  }
}

vi.mock("@/lib/auth/guard", () => ({ requireModule: (...args: unknown[]) => requireModuleMock(...args) }));
vi.mock("@/modules/ai-costs/subscription.repository", () => ({
  InvalidSubscriptionError,
  createAiSubscription: (...args: unknown[]) => createMock(...args),
  cancelAiSubscription: (...args: unknown[]) => cancelMock(...args),
  bookDueRenewals: (...args: unknown[]) => bookMock(...args),
}));
vi.mock("@/modules/audit/repository", () => ({
  recordAuditEventSafely: (...args: unknown[]) => recordAuditMock(...args),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { cancelAiSubscriptionAction, createAiSubscriptionAction } = await import("./subscription-actions");

/** Fictitious owner and values only. */
const OWNER = { id: "owner-1", workspace: { id: "ws-1", role: "OWNER" } };
const VALID = {
  provider: "openai",
  plan: "Team",
  seats: "2",
  seatPrice: "20,00",
  currency: "EUR",
  frequency: "MONTHLY",
  startDate: "2026-11-01",
  allowance: "",
  ownerId: "",
  allocationPolicyId: "",
  notes: "",
};

beforeEach(() => {
  requireModuleMock.mockReset().mockResolvedValue(OWNER);
  createMock.mockReset().mockResolvedValue({ id: "sub-1" });
  cancelMock.mockReset().mockResolvedValue(true);
  bookMock.mockReset().mockResolvedValue(1);
  recordAuditMock.mockReset();
});

describe("createAiSubscriptionAction", () => {
  it("checks the module and the write permission, saves, audits and books due renewals", async () => {
    expect((await createAiSubscriptionAction(VALID)).status).toBe("ok");
    expect(requireModuleMock).toHaveBeenCalledWith("ai-costs", "write");
    expect(createMock.mock.calls[0].slice(0, 2)).toEqual(["ws-1", "owner-1"]);
    expect(recordAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "ai_subscription.create", entityId: "sub-1", metadata: { frequency: "MONTHLY", currency: "EUR", seats: 2 } }),
    );
    expect(bookMock.mock.calls[0][0]).toBe("ws-1");
  });

  it("writes nothing for invalid input and reports a refused policy on its field", async () => {
    expect((await createAiSubscriptionAction({ ...VALID, seats: "0" })).status).toBe("invalid");
    expect(createMock).not.toHaveBeenCalled();

    createMock.mockRejectedValue(new InvalidSubscriptionError("allocationPolicyId", "refusée"));
    const result = await createAiSubscriptionAction(VALID);
    expect(result.status === "invalid" && result.fieldErrors).toEqual({ allocationPolicyId: ["refusée"] });
    expect(recordAuditMock).not.toHaveBeenCalled();
  });
});

describe("cancelAiSubscriptionAction", () => {
  it("cancels in the session's workspace and audits", async () => {
    expect((await cancelAiSubscriptionAction({ id: "sub-1", cancelledOn: "2026-12-01" })).status).toBe("ok");
    expect(cancelMock.mock.calls[0][0]).toBe("ws-1");
    expect(recordAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "ai_subscription.cancel" }));
  });

  it("reports a foreign or already cancelled subscription without auditing", async () => {
    cancelMock.mockResolvedValue(false);
    expect((await cancelAiSubscriptionAction({ id: "sub-x", cancelledOn: "2026-12-01" })).status).toBe("invalid");
    expect(recordAuditMock).not.toHaveBeenCalled();
  });
});
