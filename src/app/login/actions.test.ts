import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Signing out revokes the persisted row, so the device does not stay listed as an
 * active session. Clearing the cookie must still happen when the database is down.
 */

const getSessionUserMock = vi.fn();
const revokeSessionMock = vi.fn();
const signOutMock = vi.fn();
const recordAuditEventSafelyMock = vi.fn();

vi.mock("next-auth", () => ({
  AuthError: class AuthError extends Error {},
}));
vi.mock("@/auth", () => ({
  signIn: vi.fn(),
  signOut: (...args: unknown[]) => signOutMock(...args),
}));
vi.mock("@/lib/auth/guard", () => ({
  getSessionUser: () => getSessionUserMock(),
}));
vi.mock("@/modules/identity/sessions", () => ({
  revokeSession: (...args: unknown[]) => revokeSessionMock(...args),
}));
vi.mock("@/modules/audit/repository", () => ({
  recordAuditEventSafely: (...args: unknown[]) => recordAuditEventSafelyMock(...args),
}));

const { signOutAction } = await import("./actions");

describe("signOutAction", () => {
  beforeEach(() => {
    getSessionUserMock.mockReset().mockResolvedValue({
      id: "owner-1",
      email: "owner@example.test",
      name: null,
      sessionId: "session-current",
      workspace: { id: "ws-owner-1", name: "Personnel", kind: "PERSONAL", role: "OWNER", modules: [] },
    });
    revokeSessionMock.mockReset().mockResolvedValue(true);
    signOutMock.mockReset().mockResolvedValue(undefined);
    recordAuditEventSafelyMock.mockReset();
  });

  it("revokes the current session before clearing the cookie", async () => {
    await signOutAction();

    expect(revokeSessionMock).toHaveBeenCalledWith("owner-1", "session-current");
    expect(signOutMock).toHaveBeenCalledWith({ redirectTo: "/login" });
    expect(recordAuditEventSafelyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-owner-1",
        action: "auth.sign_out",
        entityId: "session-current",
        outcome: "SUCCESS",
      }),
    );
  });

  it("still signs out when the revocation fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    revokeSessionMock.mockRejectedValue(new Error("connection lost"));

    await signOutAction();

    expect(errorSpy).toHaveBeenCalled();
    expect(signOutMock).toHaveBeenCalledWith({ redirectTo: "/login" });
    errorSpy.mockRestore();
  });

  it("signs out an already invalid session without a write", async () => {
    getSessionUserMock.mockResolvedValue(null);

    await signOutAction();

    expect(revokeSessionMock).not.toHaveBeenCalled();
    expect(signOutMock).toHaveBeenCalledWith({ redirectTo: "/login" });
  });
});
