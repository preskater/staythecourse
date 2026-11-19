import { beforeEach, describe, expect, it, vi } from "vitest";
import { hashInvitationToken } from "@/modules/identity/invitations";

/**
 * Auth.js is not loaded here: its `next/server` import does not resolve under Vitest.
 * The action only needs the class identity to tell a refusal from a redirect.
 */
const { TestAuthError } = vi.hoisted(() => {
  class TestAuthError extends Error {}
  return { TestAuthError };
});

vi.mock("next-auth", () => ({ AuthError: TestAuthError }));

const getSessionUserMock = vi.fn();
const signInMock = vi.fn();
const hashPasswordMock = vi.fn();
const verifyPasswordMock = vi.fn();
const findInvitationMock = vi.fn();
const findOwnerByEmailMock = vi.fn();
const acceptInvitationMock = vi.fn();
const registerAndAcceptMock = vi.fn();
const recordAuditEventSafelyMock = vi.fn();
const revalidatePathMock = vi.fn();
const redirectMock = vi.fn();

vi.mock("@/lib/auth/guard", () => ({ getSessionUser: () => getSessionUserMock() }));
vi.mock("@/auth", () => ({ signIn: (...args: unknown[]) => signInMock(...args) }));
vi.mock("@/lib/auth/password", () => ({
  hashPassword: (...args: unknown[]) => hashPasswordMock(...args),
  verifyPassword: (...args: unknown[]) => verifyPasswordMock(...args),
}));
vi.mock("@/modules/identity/repository", () => ({
  findWorkspaceInvitationByTokenHash: (...args: unknown[]) => findInvitationMock(...args),
  findOwnerByEmail: (...args: unknown[]) => findOwnerByEmailMock(...args),
  acceptWorkspaceInvitation: (...args: unknown[]) => acceptInvitationMock(...args),
  registerAndAcceptWorkspaceInvitation: (...args: unknown[]) => registerAndAcceptMock(...args),
  normaliseEmail: (email: string) => email.trim().toLowerCase(),
}));
vi.mock("@/modules/audit/repository", () => ({
  recordAuditEventSafely: (...args: unknown[]) => recordAuditEventSafelyMock(...args),
}));
vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => revalidatePathMock(...args),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    redirectMock(url);
    throw new Error(`redirect:${url}`);
  },
}));

const { acceptInvitationAction, acceptInvitationAsSignedInAction } = await import("./actions");

const TOKEN = "A".repeat(43);
const TOKEN_HASH = hashInvitationToken(TOKEN);
const NOW = new Date("2026-11-13T12:00:00Z");
const EXPIRES = new Date("2026-11-20T12:00:00Z");
/** Clearly in the past, because the action reads the real clock. */
const EXPIRED = new Date("2020-01-01T00:00:00Z");

const pendingInvitation = {
  id: "inv-1",
  workspaceId: "ws-1",
  workspaceName: "Famille",
  email: "person@example.test",
  role: "MEMBER",
  createdAt: NOW,
  expiresAt: EXPIRES,
  acceptedAt: null,
  revokedAt: null,
};

const existingOwner = {
  id: "user-1",
  email: "person@example.test",
  name: "Camille",
  passwordHash: "$2b$12$existing-hash",
};

describe("acceptInvitationAction", () => {
  beforeEach(() => {
    findInvitationMock.mockReset().mockResolvedValue(pendingInvitation);
    findOwnerByEmailMock.mockReset().mockResolvedValue(null);
    acceptInvitationMock.mockReset().mockResolvedValue({ status: "ok", workspaceId: "ws-1" });
    registerAndAcceptMock
      .mockReset()
      .mockResolvedValue({ status: "ok", userId: "user-new", workspaceId: "ws-1" });
    hashPasswordMock.mockReset().mockResolvedValue("$2b$12$new-hash");
    verifyPasswordMock.mockReset();
    signInMock.mockReset().mockResolvedValue(undefined);
    recordAuditEventSafelyMock.mockReset();
    revalidatePathMock.mockReset();
  });

  it("creates the invited account, consumes the invitation and signs in", async () => {
    const result = await acceptInvitationAction({
      token: TOKEN,
      password: "Fictitious-Password-2026",
      name: "  Camille  ",
    });

    expect(result.status).toBe("ok");
    expect(registerAndAcceptMock).toHaveBeenCalledWith({
      tokenHash: TOKEN_HASH,
      email: "person@example.test",
      name: "Camille",
      passwordHash: "$2b$12$new-hash",
    });
    expect(signInMock).toHaveBeenCalledWith("credentials", {
      email: "person@example.test",
      password: "Fictitious-Password-2026",
      redirectTo: "/dashboard",
    });

    const [audit] = recordAuditEventSafelyMock.mock.calls[0] as [Record<string, unknown>];
    expect(audit).toMatchObject({
      workspaceId: "ws-1",
      actorId: "user-new",
      action: "workspace.invitation_accept",
      entityType: "INVITATION",
      entityId: "inv-1",
      outcome: "SUCCESS",
    });
    expect(JSON.stringify(audit)).not.toContain("person@example.test");
    expect(JSON.stringify(audit)).not.toContain(TOKEN);
    expect(revalidatePathMock).toHaveBeenCalledWith("/", "layout");
  });

  it("verifies the existing account's password instead of creating another account", async () => {
    findOwnerByEmailMock.mockResolvedValue(existingOwner);
    verifyPasswordMock.mockResolvedValue(true);

    const result = await acceptInvitationAction({
      token: TOKEN,
      password: "Fictitious-Password-2026",
    });

    expect(result.status).toBe("ok");
    expect(verifyPasswordMock).toHaveBeenCalledWith(
      "Fictitious-Password-2026",
      existingOwner.passwordHash,
    );
    expect(acceptInvitationMock).toHaveBeenCalledWith({
      tokenHash: TOKEN_HASH,
      userId: "user-1",
      userEmail: "person@example.test",
    });
    expect(registerAndAcceptMock).not.toHaveBeenCalled();
  });

  it("refuses a wrong password for an existing account without consuming the link", async () => {
    findOwnerByEmailMock.mockResolvedValue(existingOwner);
    verifyPasswordMock.mockResolvedValue(false);

    const result = await acceptInvitationAction({
      token: TOKEN,
      password: "Fictitious-Wrong-Password",
    });

    expect(result.status).toBe("invalid");
    expect(acceptInvitationMock).not.toHaveBeenCalled();
    expect(registerAndAcceptMock).not.toHaveBeenCalled();
    expect(signInMock).not.toHaveBeenCalled();
    expect(recordAuditEventSafelyMock).not.toHaveBeenCalled();
  });

  it("refuses an unknown, expired, revoked or reused invitation with one message", async () => {
    findInvitationMock.mockResolvedValueOnce(null);

    const unknown = await acceptInvitationAction({ token: TOKEN, password: "Fictitious-Password-2026" });
    expect(unknown).toMatchObject({ status: "error" });

    findInvitationMock.mockResolvedValueOnce({ ...pendingInvitation, expiresAt: EXPIRED });
    const expired = await acceptInvitationAction({ token: TOKEN, password: "Fictitious-Password-2026" });
    expect(expired).toMatchObject({ status: "error" });

    findInvitationMock.mockResolvedValueOnce({ ...pendingInvitation, revokedAt: NOW });
    const revoked = await acceptInvitationAction({ token: TOKEN, password: "Fictitious-Password-2026" });
    expect(revoked).toMatchObject({ status: "error" });

    findInvitationMock.mockResolvedValueOnce({ ...pendingInvitation, acceptedAt: NOW });
    const reused = await acceptInvitationAction({ token: TOKEN, password: "Fictitious-Password-2026" });
    expect(reused).toMatchObject({ status: "error" });

    expect(findOwnerByEmailMock).not.toHaveBeenCalled();
    expect(registerAndAcceptMock).not.toHaveBeenCalled();
    expect(acceptInvitationMock).not.toHaveBeenCalled();
  });

  it("reports a duplicate account after a creation race", async () => {
    registerAndAcceptMock.mockResolvedValue({ status: "account_exists" });

    const result = await acceptInvitationAction({
      token: TOKEN,
      password: "Fictitious-Password-2026",
    });

    expect(result).toMatchObject({ status: "error" });
    expect(recordAuditEventSafelyMock).not.toHaveBeenCalled();
  });

  it("keeps the accepted account usable when automatic sign-in fails", async () => {
    signInMock.mockRejectedValue(new TestAuthError("sign-in refused"));

    const result = await acceptInvitationAction({
      token: TOKEN,
      password: "Fictitious-Password-2026",
    });

    expect(result.status).toBe("error");
    // The membership was created; the message points at the manual sign-in path.
    expect(recordAuditEventSafelyMock).toHaveBeenCalled();
  });

  it("rejects a malformed token before reading the database", async () => {
    const result = await acceptInvitationAction({ token: "short", password: "Fictitious-Password-2026" });

    expect(result.status).toBe("invalid");
    expect(findInvitationMock).not.toHaveBeenCalled();
  });
});

describe("acceptInvitationAsSignedInAction", () => {
  beforeEach(() => {
    getSessionUserMock.mockReset().mockResolvedValue({
      id: "user-1",
      email: "person@example.test",
      name: null,
      sessionId: "session-1",
      workspace: { id: "ws-1", name: "Personne", kind: "PERSONAL", role: "MEMBER", modules: [] },
    });
    findInvitationMock.mockReset().mockResolvedValue(pendingInvitation);
    acceptInvitationMock.mockReset().mockResolvedValue({ status: "ok", workspaceId: "ws-1" });
    recordAuditEventSafelyMock.mockReset();
    redirectMock.mockReset();
  });

  function formData(token: string): FormData {
    const data = new FormData();
    data.set("token", token);
    return data;
  }

  it("accepts for the matching signed-in account and redirects to the dashboard", async () => {
    await expect(acceptInvitationAsSignedInAction(formData(TOKEN))).rejects.toThrow(
      "redirect:/dashboard",
    );

    expect(acceptInvitationMock).toHaveBeenCalledWith({
      tokenHash: TOKEN_HASH,
      userId: "user-1",
      userEmail: "person@example.test",
    });
    expect(recordAuditEventSafelyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "workspace.invitation_accept",
        actorId: "user-1",
        entityId: "inv-1",
      }),
    );
  });

  it("sends another signed-in address back to the invitation page", async () => {
    getSessionUserMock.mockResolvedValue({
      id: "user-2",
      email: "someone-else@example.test",
      name: null,
      sessionId: "session-2",
      workspace: { id: "ws-2", name: "Autre", kind: "PERSONAL", role: "OWNER", modules: [] },
    });

    await expect(acceptInvitationAsSignedInAction(formData(TOKEN))).rejects.toThrow(
      `redirect:/invitation/${TOKEN}`,
    );
    expect(acceptInvitationMock).not.toHaveBeenCalled();
    expect(recordAuditEventSafelyMock).not.toHaveBeenCalled();
  });

  it("sends an expired invitation back to the page instead of accepting it", async () => {
    findInvitationMock.mockResolvedValue({ ...pendingInvitation, expiresAt: EXPIRED });

    await expect(acceptInvitationAsSignedInAction(formData(TOKEN))).rejects.toThrow(
      `redirect:/invitation/${TOKEN}`,
    );
    expect(acceptInvitationMock).not.toHaveBeenCalled();
  });
});
