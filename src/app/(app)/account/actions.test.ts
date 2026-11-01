import { beforeEach, describe, expect, it, vi } from "vitest";
import { hashPassword, verifyPassword } from "@/lib/auth/password";

const requireUserMock = vi.fn();
const signOutMock = vi.fn();
const findOwnerByIdMock = vi.fn();
const updateOwnerPasswordMock = vi.fn();
const recordAuditEventSafelyMock = vi.fn();

vi.mock("@/lib/auth/guard", () => ({ requireUser: () => requireUserMock() }));
vi.mock("@/auth", () => ({ signOut: (...args: unknown[]) => signOutMock(...args) }));
vi.mock("@/modules/identity/repository", () => ({
  findOwnerById: (...args: unknown[]) => findOwnerByIdMock(...args),
  updateOwnerPassword: (...args: unknown[]) => updateOwnerPasswordMock(...args),
}));
vi.mock("@/modules/audit/repository", () => ({
  recordAuditEventSafely: (...args: unknown[]) => recordAuditEventSafelyMock(...args),
}));

const { changePasswordAction } = await import("./actions");

/**
 * Fictitious values only, and a real bcrypt hash for the current password so the
 * "current password is required" rule is exercised for real rather than mocked.
 */
const CURRENT_PASSWORD = "Fictitious-Current-2026";
const NEW_PASSWORD = "Fictitious-Replacement-2026";

const owner = {
  id: "owner-1",
  email: "owner@example.test",
  name: null as string | null,
  passwordHash: await hashPassword(CURRENT_PASSWORD),
};

const validPayload = {
  currentPassword: CURRENT_PASSWORD,
  newPassword: NEW_PASSWORD,
  confirmPassword: NEW_PASSWORD,
};

describe("changePasswordAction", () => {
  beforeEach(() => {
    requireUserMock.mockReset().mockResolvedValue({
      id: owner.id,
      email: owner.email,
      name: owner.name,
      workspace: { id: "ws-owner-1", name: "Personnel", kind: "PERSONAL", role: "OWNER", modules: [] },
    });
    signOutMock.mockReset().mockResolvedValue(undefined);
    findOwnerByIdMock.mockReset().mockResolvedValue(owner);
    updateOwnerPasswordMock.mockReset().mockResolvedValue(true);
    recordAuditEventSafelyMock.mockReset();
  });

  it("stores a bcrypt hash of the new password and signs the sessions out", async () => {
    const result = await changePasswordAction(validPayload);

    expect(result).toEqual({ status: "ok" });
    expect(updateOwnerPasswordMock).toHaveBeenCalledTimes(1);

    const [userId, storedHash] = updateOwnerPasswordMock.mock.calls[0] as [string, string];

    // Scoped to the signed-in owner: a foreign identifier would match no row.
    expect(userId).toBe(owner.id);
    // The stored value must hash back to the new password, and be a bcrypt hash.
    expect(storedHash.startsWith("$2")).toBe(true);
    expect(await verifyPassword(NEW_PASSWORD, storedHash)).toBe(true);
    // And it must not open the account with the previous password.
    expect(await verifyPassword(CURRENT_PASSWORD, storedHash)).toBe(false);

    // Signing out is what the owner actually sees, and what proves the new password.
    expect(signOutMock).toHaveBeenCalledWith({ redirectTo: "/login?changed=1" });

    const [audit] = recordAuditEventSafelyMock.mock.calls[0] as [Record<string, unknown>];
    expect(audit).toMatchObject({
      workspaceId: "ws-owner-1",
      action: "auth.password_change",
      entityType: "USER",
      entityId: owner.id,
      outcome: "SUCCESS",
    });
    expect(JSON.stringify(audit)).not.toContain(CURRENT_PASSWORD);
    expect(JSON.stringify(audit)).not.toContain(NEW_PASSWORD);
  });

  it("never writes the password in clear text", async () => {
    await changePasswordAction(validPayload);

    const [, storedHash] = updateOwnerPasswordMock.mock.calls[0] as [string, string];

    expect(storedHash).not.toContain(NEW_PASSWORD);
    expect(storedHash).not.toContain(CURRENT_PASSWORD);
  });

  it("refuses a wrong current password without writing or signing out", async () => {
    const result = await changePasswordAction({
      ...validPayload,
      currentPassword: "Fictitious-Wrong-2026",
    });

    expect(result.status).toBe("invalid");
    expect(result.status === "invalid" && result.fieldErrors.currentPassword).toHaveLength(1);
    // Nothing changed, so the session must survive: signing out here would look
    // like the change worked.
    expect(updateOwnerPasswordMock).not.toHaveBeenCalled();
    expect(signOutMock).not.toHaveBeenCalled();

    // A refusal is a safe denial code, never the submitted password.
    expect(recordAuditEventSafelyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "auth.password_change_refused",
        outcome: "REFUSED",
        metadata: { code: "INVALID_CURRENT_PASSWORD" },
      }),
    );
    expect(JSON.stringify(recordAuditEventSafelyMock.mock.calls)).not.toContain(
      "Fictitious-Wrong-2026",
    );
  });

  it("rejects a payload that breaks the policy before reading anything", async () => {
    const result = await changePasswordAction({ ...validPayload, newPassword: "short" });

    expect(result.status).toBe("invalid");
    expect(findOwnerByIdMock).not.toHaveBeenCalled();
    expect(updateOwnerPasswordMock).not.toHaveBeenCalled();
  });

  it("rejects a confirmation that does not match, without hashing", async () => {
    const result = await changePasswordAction({
      ...validPayload,
      confirmPassword: "Fictitious-Replacement-2027",
    });

    expect(result.status).toBe("invalid");
    expect(result.status === "invalid" && result.fieldErrors.confirmPassword).toHaveLength(1);
    expect(updateOwnerPasswordMock).not.toHaveBeenCalled();
  });

  it("reports a session whose owner row disappeared instead of pretending", async () => {
    findOwnerByIdMock.mockResolvedValue(null);

    const result = await changePasswordAction(validPayload);

    expect(result.status).toBe("invalid");
    expect(result.status === "invalid" && result.message).toMatch(/reconnectez-vous/);
    expect(updateOwnerPasswordMock).not.toHaveBeenCalled();
  });

  it("reports an update that matched no row rather than answering success", async () => {
    updateOwnerPasswordMock.mockResolvedValue(false);

    const result = await changePasswordAction(validPayload);

    expect(result.status).toBe("invalid");
    expect(signOutMock).not.toHaveBeenCalled();
  });

  it("answers with a generic message when the write fails, without signing out", async () => {
    updateOwnerPasswordMock.mockRejectedValue(new Error("connection lost"));

    const result = await changePasswordAction(validPayload);

    expect(result).toEqual({
      status: "error",
      message: "Enregistrement impossible pour le moment. Réessayez dans un instant.",
    });
    // The password was not replaced: signing out would strand the owner on a login
    // page while the old password still works.
    expect(signOutMock).not.toHaveBeenCalled();
  });

  it("checks the session before doing any work", async () => {
    requireUserMock.mockRejectedValue(new Error("redirect:/login"));

    await expect(changePasswordAction(validPayload)).rejects.toThrow("redirect:/login");
    expect(findOwnerByIdMock).not.toHaveBeenCalled();
    expect(updateOwnerPasswordMock).not.toHaveBeenCalled();
  });
});
