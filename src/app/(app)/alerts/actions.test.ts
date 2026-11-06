import Decimal from "decimal.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const requirePermissionMock = vi.fn();
const dismissAlertMock = vi.fn();
const saveAlertRulesMock = vi.fn();
const refreshAlertsMock = vi.fn();
const revalidatePathMock = vi.fn();

vi.mock("@/lib/auth/guard", () => ({ requirePermission: (...args: unknown[]) => requirePermissionMock(...args) }));
vi.mock("@/modules/alerts/repository", () => ({
  dismissAlert: (...args: unknown[]) => dismissAlertMock(...args),
  saveAlertRules: (...args: unknown[]) => saveAlertRulesMock(...args),
}));
vi.mock("@/modules/alerts/refresh", () => ({
  refreshAlerts: (...args: unknown[]) => refreshAlertsMock(...args),
}));
vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => revalidatePathMock(...args),
}));

const { dismissAlertAction, saveAlertRulesAction } = await import("./actions");

/**
 * Fictitious data only. The actions own the protection rules, so the repositories are
 * mocked: what is asserted here is that a dismissal is scoped to the signed-in owner,
 * that an invalid configuration writes nothing, and that saving rules re-evaluates.
 */
const OWNER = {
  id: "owner-1",
  email: "owner@example.test",
  name: null,
  workspace: { id: "ws-owner-1", role: "OWNER", modules: ["budget", "real-estate", "development"] },
};

const VALID_RULES = {
  lowBalance: { enabled: true, thresholdAmount: "100,00", thresholdCurrency: "EUR" },
  budgetOverrun: { enabled: true, thresholdPercent: "10" },
  budgetThreshold: { enabled: true, thresholdPercent: "80" },
  unusualExpense: { enabled: true, thresholdAmount: "500", thresholdCurrency: "EUR" },
  staleIntegration: { enabled: true, thresholdDays: "2" },
  overdueEvent: { enabled: true, thresholdDays: "0" },
};

beforeEach(() => {
  requirePermissionMock.mockReset().mockResolvedValue(OWNER);
  dismissAlertMock.mockReset().mockResolvedValue(true);
  saveAlertRulesMock.mockReset().mockResolvedValue(undefined);
  refreshAlertsMock.mockReset().mockResolvedValue({
    created: 0,
    refreshed: 0,
    reopened: 0,
    resolved: 0,
    active: 0,
  });
  revalidatePathMock.mockReset();
});

describe("dismissAlertAction", () => {
  it("dismisses the alert for the signed-in owner and refreshes both warning pages", async () => {
    const result = await dismissAlertAction({ id: "alert-1" });

    expect(result).toEqual({ status: "ok" });
    expect(dismissAlertMock).toHaveBeenCalledTimes(1);
    expect(dismissAlertMock.mock.calls[0][0]).toBe(OWNER.workspace.id);
    expect(dismissAlertMock.mock.calls[0][1]).toBe("alert-1");
    expect(dismissAlertMock.mock.calls[0][2]).toBeInstanceOf(Date);
    expect(revalidatePathMock).toHaveBeenCalledWith("/alerts");
    expect(revalidatePathMock).toHaveBeenCalledWith("/dashboard");
  });

  it("answers not-found instead of pretending, for a foreign or already-settled row", async () => {
    dismissAlertMock.mockResolvedValue(false);

    const result = await dismissAlertAction({ id: "alert-foreign" });

    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.fieldErrors.id?.[0]).toMatch(/écartée ou résolue/);
    }
  });

  it("refuses an unidentified dismissal without writing", async () => {
    const result = await dismissAlertAction({ id: "  " });

    expect(result.status).toBe("invalid");
    expect(dismissAlertMock).not.toHaveBeenCalled();
  });

  it("answers an unexpected failure without revealing anything", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    dismissAlertMock.mockRejectedValue(new Error("connection reset by peer"));

    const result = await dismissAlertAction({ id: "alert-1" });

    expect(result).toEqual({
      status: "error",
      message: "Enregistrement impossible pour le moment. Réessayez dans un instant.",
    });
    consoleError.mockRestore();
  });
});

describe("saveAlertRulesAction", () => {
  it("stores one configuration per kind and re-evaluates immediately", async () => {
    const result = await saveAlertRulesAction(VALID_RULES);

    expect(result).toEqual({ status: "ok" });
    expect(saveAlertRulesMock).toHaveBeenCalledTimes(1);

    const [workspaceId, configs] = saveAlertRulesMock.mock.calls[0] as [
      string,
      { kind: string; enabled: boolean; thresholdAmount: Decimal | null; thresholdCurrency: string | null; thresholdPercent: Decimal | null; thresholdDays: number | null }[],
    ];
    expect(workspaceId).toBe(OWNER.workspace.id);
    expect(configs.map((config) => config.kind)).toEqual([
      "LOW_BALANCE",
      "BUDGET_OVERRUN",
      "BUDGET_THRESHOLD",
      "UNUSUAL_EXPENSE",
      "STALE_INTEGRATION",
      "OVERDUE_EVENT",
    ]);

    const lowBalance = configs[0];
    expect(lowBalance.thresholdAmount?.toFixed(2)).toBe("100.00");
    expect(lowBalance.thresholdCurrency).toBe("EUR");
    expect(lowBalance.thresholdPercent).toBeNull();

    const overrun = configs[1];
    expect(overrun.thresholdPercent?.toFixed(2)).toBe("10.00");
    expect(overrun.thresholdAmount).toBeNull();

    const threshold = configs[2];
    expect(threshold.thresholdPercent?.toFixed(2)).toBe("80.00");

    expect(configs[4].thresholdDays).toBe(2);
    expect(configs[5].thresholdDays).toBe(0);
    expect(refreshAlertsMock).toHaveBeenCalledWith(OWNER.workspace.id);
  });

  it("accepts clearing a threshold: the default applies again", async () => {
    const result = await saveAlertRulesAction({
      ...VALID_RULES,
      lowBalance: { enabled: true, thresholdAmount: "", thresholdCurrency: "" },
    });

    expect(result).toEqual({ status: "ok" });
    const configs = saveAlertRulesMock.mock.calls[0][1] as { kind: string; thresholdAmount: Decimal | null }[];
    expect(configs[0].thresholdAmount).toBeNull();
  });

  it("refuses a positive amount threshold without a currency, and writes nothing", async () => {
    const result = await saveAlertRulesAction({
      ...VALID_RULES,
      lowBalance: { enabled: true, thresholdAmount: "100", thresholdCurrency: "" },
    });

    expect(result.status).toBe("invalid");
    expect(saveAlertRulesMock).not.toHaveBeenCalled();
    expect(refreshAlertsMock).not.toHaveBeenCalled();
  });

  it("refuses an enabled unusual-expense rule without an amount", async () => {
    const result = await saveAlertRulesAction({
      ...VALID_RULES,
      unusualExpense: { enabled: true, thresholdAmount: "", thresholdCurrency: "EUR" },
    });

    expect(result.status).toBe("invalid");
    expect(saveAlertRulesMock).not.toHaveBeenCalled();
  });

  it("answers an unexpected failure without revealing anything", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    saveAlertRulesMock.mockRejectedValue(new Error("connection reset by peer"));

    const result = await saveAlertRulesAction(VALID_RULES);

    expect(result).toEqual({
      status: "error",
      message: "Enregistrement impossible pour le moment. Réessayez dans un instant.",
    });
    consoleError.mockRestore();
  });
});

describe("forged writes", () => {
  it("propagates the guard's refusal and writes nothing for a viewer", async () => {
    requirePermissionMock.mockRejectedValue(new Error("not-found"));

    await expect(dismissAlertAction({ id: "alert-1" })).rejects.toThrow("not-found");

    expect(requirePermissionMock).toHaveBeenCalledWith("write");
    expect(dismissAlertMock).not.toHaveBeenCalled();
  });
});
