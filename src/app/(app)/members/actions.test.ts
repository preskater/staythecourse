import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requireUserMock = vi.fn();
const createWorkspaceInvitationMock = vi.fn();
const revokeWorkspaceInvitationMock = vi.fn();
const removeWorkspaceMemberMock = vi.fn();
const changeWorkspaceMemberRoleMock = vi.fn();
const transferWorkspaceOwnershipMock = vi.fn();
const recordAuditEventSafelyMock = vi.fn();
const revalidatePathMock = vi.fn();

vi.mock("@/lib/auth/guard", () => ({ requireUser: () => requireUserMock() }));
vi.mock("@/modules/identity/repository", () => ({
  createWorkspaceInvitation: (...args: unknown[]) => createWorkspaceInvitationMock(...args),
  revokeWorkspaceInvitation: (...args: unknown[]) => revokeWorkspaceInvitationMock(...args),
  removeWorkspaceMember: (...args: unknown[]) => removeWorkspaceMemberMock(...args),
  changeWorkspaceMemberRole: (...args: unknown[]) => changeWorkspaceMemberRoleMock(...args),
  transferWorkspaceOwnership: (...args: unknown[]) => transferWorkspaceOwnershipMock(...args),
}));
vi.mock("@/modules/audit/repository", () => ({
  recordAuditEventSafely: (...args: unknown[]) => recordAuditEventSafelyMock(...args),
}));
vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => revalidatePathMock(...args),
}));

const {
  changeMemberRoleAction,
  inviteMemberAction,
  removeMemberAction,
  revokeInvitationAction,
  transferOwnershipAction,
} = await import("./actions");

function sessionAs(role: string) {
  return {
    id: "user-1",
    email: "owner@example.test",
    name: null,
    sessionId: "session-1",
    workspace: { id: "ws-1", name: "Personnel", kind: "PERSONAL", role, modules: [] },
  };
}

describe("inviteMemberAction", () => {
  beforeEach(() => {
    vi.stubEnv("AUTH_URL", "https://dashboard.example.test");
    requireUserMock.mockReset().mockResolvedValue(sessionAs("OWNER"));
    createWorkspaceInvitationMock
      .mockReset()
      .mockResolvedValue({ status: "ok", id: "inv-1", replaced: 0 });
    recordAuditEventSafelyMock.mockReset();
    revalidatePathMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("creates a link, shows it once and audits the invitation without the address or token", async () => {
    const result = await inviteMemberAction({
      email: " Person@Example.TEST ",
      role: "MEMBER",
    });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    expect(result.invitationUrl).toMatch(
      /^https:\/\/dashboard\.example\.test\/invitation\/[A-Za-z0-9_-]{43}$/,
    );

    const [input] = createWorkspaceInvitationMock.mock.calls[0] as [
      {
        workspaceId: string;
        actorId: string;
        email: string;
        role: string;
        tokenHash: string;
      },
    ];
    expect(input).toMatchObject({
      workspaceId: "ws-1",
      actorId: "user-1",
      email: "Person@Example.TEST",
      role: "MEMBER",
    });
    expect(input.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    // The raw token exists only in the link; the digest is what the repository sees.
    expect(result.invitationUrl).not.toContain(input.tokenHash);

    const [audit] = recordAuditEventSafelyMock.mock.calls[0] as [Record<string, unknown>];
    expect(audit).toMatchObject({
      workspaceId: "ws-1",
      actorId: "user-1",
      action: "workspace.invite",
      entityType: "INVITATION",
      entityId: "inv-1",
      outcome: "SUCCESS",
      metadata: { role: "MEMBER", replaced: 0 },
    });
    expect(JSON.stringify(audit)).not.toContain("person@example.test");
    expect(JSON.stringify(audit)).not.toContain(result.invitationUrl);
    expect(revalidatePathMock).toHaveBeenCalledWith("/members");
  });

  it("refuses a role the actor may not grant, before any repository call", async () => {
    requireUserMock.mockResolvedValue(sessionAs("ADMIN"));

    const result = await inviteMemberAction({ email: "person@example.test", role: "ADMIN" });

    expect(result.status).toBe("invalid");
    expect(createWorkspaceInvitationMock).not.toHaveBeenCalled();
    expect(recordAuditEventSafelyMock).not.toHaveBeenCalled();
  });

  it("refuses a role without manage-members", async () => {
    requireUserMock.mockResolvedValue(sessionAs("MEMBER"));

    const result = await inviteMemberAction({ email: "person@example.test", role: "VIEWER" });

    expect(result.status).toBe("error");
    expect(createWorkspaceInvitationMock).not.toHaveBeenCalled();
  });

  it("reports an address that is already a member", async () => {
    createWorkspaceInvitationMock.mockResolvedValue({ status: "already_member" });

    const result = await inviteMemberAction({ email: "person@example.test", role: "MEMBER" });

    expect(result.status).toBe("invalid");
    expect(recordAuditEventSafelyMock).not.toHaveBeenCalled();
  });
});

describe("revokeInvitationAction", () => {
  beforeEach(() => {
    requireUserMock.mockReset().mockResolvedValue(sessionAs("OWNER"));
    revokeWorkspaceInvitationMock.mockReset();
    recordAuditEventSafelyMock.mockReset();
    revalidatePathMock.mockReset();
  });

  it("revokes a live invitation and audits it", async () => {
    revokeWorkspaceInvitationMock.mockResolvedValue("ok");

    expect(await revokeInvitationAction({ invitationId: "inv-1" })).toEqual({
      status: "ok",
      message: "Invitation révoquée.",
    });
    expect(revokeWorkspaceInvitationMock).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      actorId: "user-1",
      invitationId: "inv-1",
    });
    expect(recordAuditEventSafelyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "workspace.invitation_revoke",
        entityType: "INVITATION",
        entityId: "inv-1",
      }),
    );
  });

  it("answers the same way for an unknown or already used invitation", async () => {
    revokeWorkspaceInvitationMock.mockResolvedValue("not_found");

    const result = await revokeInvitationAction({ invitationId: "inv-1" });

    expect(result.status).toBe("invalid");
    expect(recordAuditEventSafelyMock).not.toHaveBeenCalled();
  });
});

describe("removeMemberAction", () => {
  beforeEach(() => {
    requireUserMock.mockReset().mockResolvedValue(sessionAs("ADMIN"));
    removeWorkspaceMemberMock.mockReset();
    recordAuditEventSafelyMock.mockReset();
    revalidatePathMock.mockReset();
  });

  it("removes a member and audits the target identifier only", async () => {
    removeWorkspaceMemberMock.mockResolvedValue("ok");

    expect(await removeMemberAction({ userId: "user-2" })).toMatchObject({ status: "ok" });
    expect(removeWorkspaceMemberMock).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      actorId: "user-1",
      targetUserId: "user-2",
    });
    const [audit] = recordAuditEventSafelyMock.mock.calls[0] as [Record<string, unknown>];
    expect(audit).toMatchObject({
      action: "workspace.member_remove",
      entityType: "USER",
      entityId: "user-2",
    });
  });

  it("refuses the owner and writes no audit entry", async () => {
    removeWorkspaceMemberMock.mockResolvedValue("forbidden");

    const result = await removeMemberAction({ userId: "owner-2" });

    expect(result.status).toBe("error");
    expect(recordAuditEventSafelyMock).not.toHaveBeenCalled();
  });
});

describe("changeMemberRoleAction", () => {
  beforeEach(() => {
    requireUserMock.mockReset().mockResolvedValue(sessionAs("OWNER"));
    changeWorkspaceMemberRoleMock.mockReset();
    recordAuditEventSafelyMock.mockReset();
    revalidatePathMock.mockReset();
  });

  it("changes the role and records the new role code", async () => {
    changeWorkspaceMemberRoleMock.mockResolvedValue("ok");

    expect(await changeMemberRoleAction({ userId: "user-2", role: "VIEWER" })).toMatchObject({
      status: "ok",
    });
    expect(changeWorkspaceMemberRoleMock).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      actorId: "user-1",
      targetUserId: "user-2",
      role: "VIEWER",
    });
    expect(recordAuditEventSafelyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "workspace.member_role_change",
        entityId: "user-2",
        metadata: { role: "VIEWER" },
      }),
    );
  });

  it("never accepts the owner role from the browser", async () => {
    const result = await changeMemberRoleAction({ userId: "user-2", role: "OWNER" });

    expect(result.status).toBe("invalid");
    expect(changeWorkspaceMemberRoleMock).not.toHaveBeenCalled();
  });
});

describe("transferOwnershipAction", () => {
  beforeEach(() => {
    requireUserMock.mockReset().mockResolvedValue(sessionAs("OWNER"));
    transferWorkspaceOwnershipMock.mockReset();
    recordAuditEventSafelyMock.mockReset();
    revalidatePathMock.mockReset();
  });

  it("transfers ownership and audits the target", async () => {
    transferWorkspaceOwnershipMock.mockResolvedValue("ok");

    expect(await transferOwnershipAction({ userId: "user-2" })).toMatchObject({ status: "ok" });
    expect(transferWorkspaceOwnershipMock).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      actorId: "user-1",
      targetUserId: "user-2",
    });
    expect(recordAuditEventSafelyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "workspace.ownership_transfer",
        entityType: "USER",
        entityId: "user-2",
        metadata: { role: "OWNER" },
      }),
    );
  });

  it("refuses an actor who is not the owner, before any write", async () => {
    requireUserMock.mockResolvedValue(sessionAs("ADMIN"));

    const result = await transferOwnershipAction({ userId: "user-2" });

    expect(result.status).toBe("error");
    expect(transferWorkspaceOwnershipMock).not.toHaveBeenCalled();
  });
});
