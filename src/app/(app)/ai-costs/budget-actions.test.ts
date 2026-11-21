import { beforeEach, describe, expect, it, vi } from "vitest";

const requireModuleMock = vi.fn();
const upsertMock = vi.fn();
const deleteMock = vi.fn();
const refreshAlertsMock = vi.fn();
const recordAuditMock = vi.fn();

class AiBudgetLimitError extends Error {}

vi.mock("@/lib/auth/guard", () => ({ requireModule: (...args: unknown[]) => requireModuleMock(...args) }));
vi.mock("@/modules/ai-costs/repository", () => ({
  AiBudgetLimitError,
  upsertAiBudget: (...args: unknown[]) => upsertMock(...args),
  deleteAiBudget: (...args: unknown[]) => deleteMock(...args),
}));
vi.mock("@/modules/alerts/refresh", () => ({ refreshAlerts: (...args: unknown[]) => refreshAlertsMock(...args) }));
vi.mock("@/modules/audit/repository", () => ({
  recordAuditEventSafely: (...args: unknown[]) => recordAuditMock(...args),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { deleteAiBudgetAction, saveAiBudgetAction } = await import("./budget-actions");

/** Fictitious owner and values only. */
const OWNER = { id: "owner-1", workspace: { id: "ws-1", role: "OWNER" } };
const VALID = { dimension: "provider", dimensionValue: "openai", amount: "200,00", currency: "EUR" };

beforeEach(() => {
  requireModuleMock.mockReset().mockResolvedValue(OWNER);
  upsertMock.mockReset().mockResolvedValue({ id: "budget-1", created: true });
  deleteMock.mockReset().mockResolvedValue(true);
  refreshAlertsMock.mockReset().mockResolvedValue({});
  recordAuditMock.mockReset();
});

describe("saveAiBudgetAction", () => {
  it("requires the active module and the write permission, saves, audits and re-evaluates", async () => {
    const result = await saveAiBudgetAction(VALID);

    expect(result.status).toBe("ok");
    expect(requireModuleMock).toHaveBeenCalledWith("ai-costs", "write");
    expect(upsertMock.mock.calls[0][0]).toBe("ws-1");
    expect(recordAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ai_budget.create",
        entityType: "AI_BUDGET",
        entityId: "budget-1",
        metadata: { dimension: "provider", currency: "EUR", replaced: false },
      }),
    );
    expect(refreshAlertsMock).toHaveBeenCalledWith("ws-1");
  });

  it("writes nothing for an invalid budget", async () => {
    const result = await saveAiBudgetAction({ ...VALID, amount: "0" });

    expect(result.status).toBe("invalid");
    expect(upsertMock).not.toHaveBeenCalled();
    expect(recordAuditMock).not.toHaveBeenCalled();
  });

  it("explains the bound instead of failing blindly", async () => {
    upsertMock.mockRejectedValue(new AiBudgetLimitError());

    const result = await saveAiBudgetAction(VALID);

    expect(result.status).toBe("invalid");
    expect(recordAuditMock).not.toHaveBeenCalled();
  });

  it("stops at the guard for a viewer", async () => {
    requireModuleMock.mockRejectedValue(new Error("NEXT_NOT_FOUND"));

    await expect(saveAiBudgetAction(VALID)).rejects.toThrow("NEXT_NOT_FOUND");
    expect(upsertMock).not.toHaveBeenCalled();
  });
});

describe("deleteAiBudgetAction", () => {
  it("deletes in the session's workspace and audits", async () => {
    expect((await deleteAiBudgetAction({ id: "budget-1" })).status).toBe("ok");
    expect(deleteMock).toHaveBeenCalledWith("ws-1", "budget-1");
    expect(recordAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "ai_budget.delete" }));
  });

  it("reports a foreign or missing budget as not found, without auditing", async () => {
    deleteMock.mockResolvedValue(false);

    expect((await deleteAiBudgetAction({ id: "budget-x" })).status).toBe("invalid");
    expect(recordAuditMock).not.toHaveBeenCalled();
  });
});
