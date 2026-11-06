import { beforeEach, describe, expect, it, vi } from "vitest";

const requireUserMock = vi.fn();
const applyModuleChangeMock = vi.fn();
const revalidatePathMock = vi.fn();
const recordAuditEventSafelyMock = vi.fn();

vi.mock("@/lib/auth/guard", () => ({ requireUser: () => requireUserMock() }));
vi.mock("@/modules/catalog/repository", () => ({
  applyModuleChange: (...args: unknown[]) => applyModuleChangeMock(...args),
}));
vi.mock("@/modules/audit/repository", () => ({
  recordAuditEventSafely: (...args: unknown[]) => recordAuditEventSafelyMock(...args),
}));
vi.mock("next/cache", () => ({ revalidatePath: (...args: unknown[]) => revalidatePathMock(...args) }));

const { setModuleEnabledAction } = await import("./actions");

/** Fictitious session; the workspace always comes from it, never from the request. */
function sessionAs(role: string) {
  return {
    id: "user-1",
    email: "owner@example.test",
    name: null,
    workspace: { id: "ws-user-1", name: "Personnel", kind: "PERSONAL", role, modules: ["budget"] },
  };
}

describe("setModuleEnabledAction", () => {
  beforeEach(() => {
    requireUserMock.mockReset().mockResolvedValue(sessionAs("OWNER"));
    applyModuleChangeMock.mockReset();
    revalidatePathMock.mockReset();
    recordAuditEventSafelyMock.mockReset();
  });

  it("disables a module of the session's workspace and refreshes every page", async () => {
    applyModuleChangeMock.mockResolvedValue({ status: "ok", key: "budget", enabled: false });

    const result = await setModuleEnabledAction({ key: "budget", enabled: false, workspaceId: "ws-other" });

    expect(result.status).toBe("ok");
    expect(applyModuleChangeMock).toHaveBeenCalledWith("ws-user-1", { key: "budget", enabled: false });
    expect(revalidatePathMock).toHaveBeenCalledWith("/", "layout");
    expect(recordAuditEventSafelyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-user-1",
        action: "module.disable",
        entityType: "MODULE",
        entityId: "budget",
      }),
    );
  });

  it.each(["MEMBER", "VIEWER"])("refuses a %s without writing", async (role) => {
    requireUserMock.mockResolvedValue(sessionAs(role));

    const result = await setModuleEnabledAction({ key: "budget", enabled: false });

    expect(result.status).toBe("error");
    expect(applyModuleChangeMock).not.toHaveBeenCalled();
    // A failed authorisation writes nothing.
    expect(recordAuditEventSafelyMock).not.toHaveBeenCalled();
  });

  it("names the missing prerequisites", async () => {
    applyModuleChangeMock.mockResolvedValue({ status: "missing_prerequisites", missing: ["real-estate"] });

    const result = await setModuleEnabledAction({ key: "profitability", enabled: true });

    expect(result).toMatchObject({ status: "invalid", message: "Activez d'abord : Immobilier." });
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  it("refuses an unknown module and a malformed request", async () => {
    applyModuleChangeMock.mockResolvedValue({ status: "unknown_module" });

    expect((await setModuleEnabledAction({ key: "billing", enabled: true })).status).toBe("invalid");
    expect((await setModuleEnabledAction({ key: "budget", enabled: "yes" })).status).toBe("invalid");
    expect(applyModuleChangeMock).toHaveBeenCalledTimes(1);
  });
});
