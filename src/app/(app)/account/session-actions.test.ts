import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Session revocation actions.
 *
 * Every refusal is deliberately indistinguishable: malformed, unknown, foreign and
 * already-revoked identifiers all answer "Session introuvable." The responses are
 * also checked for token material, since they are sent back to the browser.
 */

const requireUserMock = vi.fn();
const revokeSessionMock = vi.fn();
const revokeOtherSessionsMock = vi.fn();
const signOutMock = vi.fn();
const recordAuditEventSafelyMock = vi.fn();

vi.mock("@/lib/auth/guard", () => ({ requireUser: () => requireUserMock() }));
vi.mock("@/modules/identity/sessions", () => ({
  revokeSession: (...args: unknown[]) => revokeSessionMock(...args),
  revokeOtherSessions: (...args: unknown[]) => revokeOtherSessionsMock(...args),
}));
vi.mock("@/auth", () => ({ signOut: (...args: unknown[]) => signOutMock(...args) }));
vi.mock("@/modules/audit/repository", () => ({
  recordAuditEventSafely: (...args: unknown[]) => recordAuditEventSafelyMock(...args),
}));

const { revokeOtherSessionsAction, revokeSessionAction } = await import("./session-actions");

const user = {
  id: "owner-1",
  email: "owner@example.test",
  name: null as string | null,
  sessionId: "session-current",
  workspace: { id: "ws-owner-1", name: "Personnel", kind: "PERSONAL", role: "OWNER", modules: [] },
};

/** No response ever carries a token, a JWT or a session identifier. */
function expectNoTokenMaterial(response: unknown): void {
  expect(JSON.stringify(response)).not.toMatch(/token|jwt|bearer|secret/i);
}

describe("revokeSessionAction", () => {
  beforeEach(() => {
    requireUserMock.mockReset().mockResolvedValue(user);
    revokeSessionMock.mockReset().mockResolvedValue(true);
    revokeOtherSessionsMock.mockReset();
    signOutMock.mockReset().mockResolvedValue(undefined);
    recordAuditEventSafelyMock.mockReset();
  });

  it("revokes one session, scoped to the signed-in owner", async () => {
    const result = await revokeSessionAction({ id: "session-other" });

    expect(result).toEqual({ status: "ok", message: "Session révoquée." });
    expect(revokeSessionMock).toHaveBeenCalledWith(user.id, "session-other");
    expect(signOutMock).not.toHaveBeenCalled();
    expect(recordAuditEventSafelyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "auth.session_revoke",
        entityType: "SESSION",
        entityId: "session-other",
        metadata: { scope: "ONE" },
      }),
    );
    expectNoTokenMaterial(result);
  });

  it("answers every unknown, foreign or already revoked id the same way", async () => {
    revokeSessionMock.mockResolvedValue(false);

    const result = await revokeSessionAction({ id: "someone-elses-session" });

    expect(result).toEqual({
      status: "invalid",
      message: "Session introuvable.",
      fieldErrors: { id: ["Session introuvable."] },
    });
    // The query is narrowed by owner, so a foreign row is never even considered.
    expect(revokeSessionMock).toHaveBeenCalledWith(user.id, "someone-elses-session");
    // A failed revocation writes nothing: no row changed.
    expect(recordAuditEventSafelyMock).not.toHaveBeenCalled();
    expectNoTokenMaterial(result);
  });

  it("rejects a malformed identifier before querying the database", async () => {
    for (const payload of [{}, { id: "" }, { id: "   " }, { id: 42 }, null]) {
      const result = await revokeSessionAction(payload);

      expect(result).toMatchObject({ status: "invalid", message: "Session introuvable." });
    }

    expect(revokeSessionMock).not.toHaveBeenCalled();
  });

  it("does not leak the cause of a failed write", async () => {
    revokeSessionMock.mockRejectedValue(new Error("connection lost"));

    const result = await revokeSessionAction({ id: "session-other" });

    expect(result.status).toBe("error");
    expect(result.status === "error" && result.message).not.toContain("connection lost");
    expectNoTokenMaterial(result);
  });

  it("signs out when the revoked session is the current one", async () => {
    const result = await revokeSessionAction({ id: user.sessionId });

    expect(revokeSessionMock).toHaveBeenCalledWith(user.id, user.sessionId);
    expect(signOutMock).toHaveBeenCalledWith({ redirectTo: "/login?revoked=1" });
    expect(result).toEqual({ status: "ok", message: "Session révoquée." });
  });

  it("checks the session before reading the payload", async () => {
    requireUserMock.mockRejectedValue(new Error("redirect:/login"));

    await expect(revokeSessionAction({ id: "session-other" })).rejects.toThrow(
      "redirect:/login",
    );
    expect(revokeSessionMock).not.toHaveBeenCalled();
  });
});

describe("revokeOtherSessionsAction", () => {
  beforeEach(() => {
    requireUserMock.mockReset().mockResolvedValue(user);
    revokeSessionMock.mockReset();
    revokeOtherSessionsMock.mockReset().mockResolvedValue(2);
    signOutMock.mockReset();
    recordAuditEventSafelyMock.mockReset();
  });

  it("keeps the current session and revokes the others", async () => {
    const result = await revokeOtherSessionsAction();

    expect(revokeOtherSessionsMock).toHaveBeenCalledWith(user.id, user.sessionId);
    expect(result).toEqual({ status: "ok", message: "2 sessions révoquées." });
    expect(recordAuditEventSafelyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "auth.session_revoke",
        metadata: { scope: "OTHERS", count: 2 },
      }),
    );
    expectNoTokenMaterial(result);
  });

  it("uses the singular for one other session", async () => {
    revokeOtherSessionsMock.mockResolvedValue(1);

    const result = await revokeOtherSessionsAction();

    expect(result).toEqual({ status: "ok", message: "1 session révoquée." });
  });

  it("says so when nothing else was active", async () => {
    revokeOtherSessionsMock.mockResolvedValue(0);

    const result = await revokeOtherSessionsAction();

    expect(result).toEqual({ status: "ok", message: "Aucune autre session active." });
  });

  it("answers with a generic message when the write fails", async () => {
    revokeOtherSessionsMock.mockRejectedValue(new Error("connection lost"));

    const result = await revokeOtherSessionsAction();

    expect(result.status).toBe("error");
    expect(result.status === "error" && result.message).not.toContain("connection lost");
  });
});
