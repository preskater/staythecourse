import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Invitation and membership lifecycle (M8-01), against a mocked database.
 *
 * What matters here is the shape and the ordering of the writes: single-use is a
 * conditional update, ownership transfer is a demotion and a promotion in one
 * transaction, and no path can reach the owner's membership.
 */

const memberFindUnique = vi.fn();
const memberFindFirst = vi.fn();
const memberCreate = vi.fn();
const memberUpsert = vi.fn();
const memberUpdateMany = vi.fn();
const memberDeleteMany = vi.fn();
const memberFindMany = vi.fn();

const invitationFindUnique = vi.fn();
const invitationFindMany = vi.fn();
const invitationCreate = vi.fn();
const invitationUpdate = vi.fn();
const invitationUpdateMany = vi.fn();

const userCreate = vi.fn();
const transaction = vi.fn();

const prisma = {
  workspaceMember: {
    findUnique: memberFindUnique,
    findFirst: memberFindFirst,
    create: memberCreate,
    upsert: memberUpsert,
    updateMany: memberUpdateMany,
    deleteMany: memberDeleteMany,
    findMany: memberFindMany,
  },
  workspaceInvitation: {
    findUnique: invitationFindUnique,
    findMany: invitationFindMany,
    create: invitationCreate,
    update: invitationUpdate,
    updateMany: invitationUpdateMany,
  },
  user: { create: userCreate },
  $transaction: transaction,
};

vi.mock("@/lib/db", () => ({ getPrisma: () => prisma }));

const {
  acceptWorkspaceInvitation,
  changeWorkspaceMemberRole,
  createWorkspaceInvitation,
  listWorkspaceMembers,
  registerAndAcceptWorkspaceInvitation,
  removeWorkspaceMember,
  revokeWorkspaceInvitation,
  transferWorkspaceOwnership,
} = await import("./repository");

const NOW = new Date("2026-11-13T12:00:00Z");
const EXPIRES = new Date("2026-11-20T12:00:00Z");

/** A live, unused invitation for the address every test signs in with. */
const pendingInvitation = {
  id: "inv-1",
  workspaceId: "ws-1",
  email: "person@example.test",
  role: "MEMBER",
  createdAt: NOW,
  expiresAt: EXPIRES,
  acceptedAt: null,
  revokedAt: null,
};

/** A member lookup keyed by user id, the way the repository reads actor and target. */
function membersByUserId(members: Record<string, { role: string } | null>) {
  memberFindUnique.mockImplementation(
    ({ where }: { where: { workspaceId_userId: { userId: string } } }) =>
      Promise.resolve(members[where.workspaceId_userId.userId] ?? null),
  );
}

describe("workspace invites", () => {
  beforeEach(() => {
    transaction.mockReset().mockImplementation(async (work: unknown) => {
      return typeof work === "function" ? work(prisma) : Promise.all(work as Promise<unknown>[]);
    });
    memberFindUnique.mockReset();
    memberFindFirst.mockReset().mockResolvedValue(null);
    invitationUpdateMany.mockReset().mockResolvedValue({ count: 0 });
    invitationCreate.mockReset().mockResolvedValue({ id: "inv-1" });
  });

  it("replaces an older live link and stores the normalized address and role", async () => {
    membersByUserId({ "actor-1": { role: "OWNER" } });

    const result = await createWorkspaceInvitation({
      workspaceId: "ws-1",
      actorId: "actor-1",
      email: "  Person@Example.TEST ",
      role: "MEMBER",
      tokenHash: "digest",
      expiresAt: EXPIRES,
      now: NOW,
    });

    expect(result).toEqual({ status: "ok", id: "inv-1", replaced: 0 });
    // The previous link for the same address is revoked in the same transaction.
    expect(invitationUpdateMany).toHaveBeenCalledWith({
      where: {
        workspaceId: "ws-1",
        email: "person@example.test",
        acceptedAt: null,
        revokedAt: null,
        expiresAt: { gt: NOW },
      },
      data: { revokedAt: NOW },
    });
    expect(invitationCreate).toHaveBeenCalledWith({
      data: {
        workspaceId: "ws-1",
        email: "person@example.test",
        role: "MEMBER",
        tokenHash: "digest",
        invitedById: "actor-1",
        expiresAt: EXPIRES,
      },
      select: { id: true },
    });
  });

  it("refuses a role the actor may not grant, without writing", async () => {
    membersByUserId({ "actor-1": { role: "ADMIN" } });

    const result = await createWorkspaceInvitation({
      workspaceId: "ws-1",
      actorId: "actor-1",
      email: "person@example.test",
      role: "ADMIN",
      tokenHash: "digest",
      expiresAt: EXPIRES,
      now: NOW,
    });

    expect(result).toEqual({ status: "forbidden" });
    expect(invitationUpdateMany).not.toHaveBeenCalled();
    expect(invitationCreate).not.toHaveBeenCalled();
  });

  it("refuses an address that is already a member", async () => {
    membersByUserId({ "actor-1": { role: "OWNER" } });
    memberFindFirst.mockResolvedValue({ id: "wm-existing" });

    const result = await createWorkspaceInvitation({
      workspaceId: "ws-1",
      actorId: "actor-1",
      email: "person@example.test",
      role: "MEMBER",
      tokenHash: "digest",
      expiresAt: EXPIRES,
      now: NOW,
    });

    expect(result).toEqual({ status: "already_member" });
    expect(invitationCreate).not.toHaveBeenCalled();
  });
});

describe("workspace invite acceptance", () => {
  beforeEach(() => {
    transaction.mockReset().mockImplementation(async (work: unknown) => {
      return typeof work === "function" ? work(prisma) : Promise.all(work as Promise<unknown>[]);
    });
    invitationFindUnique.mockReset().mockResolvedValue(pendingInvitation);
    invitationUpdateMany.mockReset().mockResolvedValue({ count: 1 });
    memberUpsert.mockReset().mockResolvedValue({ id: "wm-1" });
    memberCreate.mockReset().mockResolvedValue({ id: "wm-1" });
    invitationUpdate.mockReset().mockResolvedValue({ id: "inv-1" });
    userCreate.mockReset().mockResolvedValue({ id: "user-new" });
  });

  it("consumes a live invitation and creates the membership in one transaction", async () => {
    const result = await acceptWorkspaceInvitation({
      tokenHash: "digest",
      userId: "user-1",
      userEmail: "Person@Example.test",
      now: NOW,
    });

    expect(result).toEqual({ status: "ok", workspaceId: "ws-1" });
    expect(invitationUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "inv-1",
        acceptedAt: null,
        revokedAt: null,
        expiresAt: { gt: NOW },
      },
      data: { acceptedAt: NOW, acceptedByUserId: "user-1" },
    });
    expect(memberUpsert).toHaveBeenCalledWith({
      where: { workspaceId_userId: { workspaceId: "ws-1", userId: "user-1" } },
      create: { workspaceId: "ws-1", userId: "user-1", role: "MEMBER" },
      // An existing membership keeps its role: an invitation never escalates.
      update: {},
    });
  });

  it("refuses an expired invitation, at the expiry instant", async () => {
    invitationFindUnique.mockResolvedValue({ ...pendingInvitation, expiresAt: NOW });

    expect(
      await acceptWorkspaceInvitation({
        tokenHash: "digest",
        userId: "user-1",
        userEmail: "person@example.test",
        now: NOW,
      }),
    ).toEqual({ status: "invalid" });
    expect(invitationUpdateMany).not.toHaveBeenCalled();
    expect(memberUpsert).not.toHaveBeenCalled();
  });

  it("refuses a revoked or already used invitation", async () => {
    invitationFindUnique.mockResolvedValueOnce({ ...pendingInvitation, revokedAt: NOW });

    expect(
      await acceptWorkspaceInvitation({
        tokenHash: "digest",
        userId: "user-1",
        userEmail: "person@example.test",
        now: NOW,
      }),
    ).toEqual({ status: "invalid" });

    invitationFindUnique.mockResolvedValueOnce({ ...pendingInvitation, acceptedAt: NOW });

    expect(
      await acceptWorkspaceInvitation({
        tokenHash: "digest",
        userId: "user-1",
        userEmail: "person@example.test",
        now: NOW,
      }),
    ).toEqual({ status: "invalid" });
    expect(invitationUpdateMany).not.toHaveBeenCalled();
  });

  it("refuses a token used by another address", async () => {
    expect(
      await acceptWorkspaceInvitation({
        tokenHash: "digest",
        userId: "user-1",
        userEmail: "someone-else@example.test",
        now: NOW,
      }),
    ).toEqual({ status: "email_mismatch" });
    expect(invitationUpdateMany).not.toHaveBeenCalled();
  });

  it("treats a lost acceptance race as an invalid invitation", async () => {
    invitationUpdateMany.mockResolvedValue({ count: 0 });

    expect(
      await acceptWorkspaceInvitation({
        tokenHash: "digest",
        userId: "user-1",
        userEmail: "person@example.test",
        now: NOW,
      }),
    ).toEqual({ status: "invalid" });
    expect(memberUpsert).not.toHaveBeenCalled();
  });

  it("creates the account inside the same transaction that consumes the invitation", async () => {
    const result = await registerAndAcceptWorkspaceInvitation({
      tokenHash: "digest",
      email: "person@example.test",
      name: "Camille",
      passwordHash: "$2b$12$a-fictitious-hash",
      now: NOW,
    });

    expect(result).toEqual({ status: "ok", userId: "user-new", workspaceId: "ws-1" });
    expect(invitationUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "inv-1",
        acceptedAt: null,
        revokedAt: null,
        expiresAt: { gt: NOW },
      },
      data: { acceptedAt: NOW },
    });
    expect(userCreate).toHaveBeenCalledWith({
      data: {
        email: "person@example.test",
        name: "Camille",
        passwordHash: "$2b$12$a-fictitious-hash",
      },
      select: { id: true },
    });
    expect(invitationUpdate).toHaveBeenCalledWith({
      where: { id: "inv-1" },
      data: { acceptedByUserId: "user-new" },
      select: { id: true },
    });
    expect(memberCreate).toHaveBeenCalledWith({
      data: { workspaceId: "ws-1", userId: "user-new", role: "MEMBER" },
      select: { id: true },
    });
    // The invitation is consumed before the user exists, so a duplicate address can
    // never leave an accepted invitation with no account behind it.
    expect(invitationUpdateMany.mock.invocationCallOrder[0]).toBeLessThan(
      userCreate.mock.invocationCallOrder[0],
    );
  });

  it("reports a duplicate address after rolling the transaction back", async () => {
    userCreate.mockRejectedValue({ code: "P2002" });

    expect(
      await registerAndAcceptWorkspaceInvitation({
        tokenHash: "digest",
        email: "person@example.test",
        name: null,
        passwordHash: "$2b$12$a-fictitious-hash",
        now: NOW,
      }),
    ).toEqual({ status: "account_exists" });
    expect(memberCreate).not.toHaveBeenCalled();
  });
});

describe("workspace membership changes", () => {
  beforeEach(() => {
    transaction.mockReset().mockImplementation(async (work: unknown) => {
      return typeof work === "function" ? work(prisma) : Promise.all(work as Promise<unknown>[]);
    });
    memberUpdateMany.mockReset().mockResolvedValue({ count: 1 });
    memberDeleteMany.mockReset().mockResolvedValue({ count: 1 });
    invitationUpdateMany.mockReset().mockResolvedValue({ count: 1 });
  });

  it("never removes the owner, by anyone", async () => {
    membersByUserId({ "actor-1": { role: "ADMIN" }, "owner-1": { role: "OWNER" } });

    expect(
      await removeWorkspaceMember({
        workspaceId: "ws-1",
        actorId: "actor-1",
        targetUserId: "owner-1",
      }),
    ).toBe("forbidden");
    expect(memberDeleteMany).not.toHaveBeenCalled();
  });

  it("removes a member with the target role repeated in the delete", async () => {
    membersByUserId({ "actor-1": { role: "ADMIN" }, "member-1": { role: "MEMBER" } });

    expect(
      await removeWorkspaceMember({
        workspaceId: "ws-1",
        actorId: "actor-1",
        targetUserId: "member-1",
      }),
    ).toBe("ok");
    expect(memberDeleteMany).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1", userId: "member-1", role: "MEMBER" },
    });
  });

  it("never grants OWNER or changes the owner through a role change", async () => {
    membersByUserId({ "actor-1": { role: "OWNER" }, "owner-2": { role: "OWNER" } });

    expect(
      await changeWorkspaceMemberRole({
        workspaceId: "ws-1",
        actorId: "actor-1",
        targetUserId: "owner-2",
        role: "MEMBER",
      }),
    ).toBe("forbidden");
    expect(memberUpdateMany).not.toHaveBeenCalled();
  });

  it("changes a member's role and repeats the previous role in the update", async () => {
    membersByUserId({ "actor-1": { role: "ADMIN" }, "member-1": { role: "MEMBER" } });

    expect(
      await changeWorkspaceMemberRole({
        workspaceId: "ws-1",
        actorId: "actor-1",
        targetUserId: "member-1",
        role: "VIEWER",
      }),
    ).toBe("ok");
    expect(memberUpdateMany).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1", userId: "member-1", role: "MEMBER" },
      data: { role: "VIEWER" },
    });
  });

  it("revokes only a live invitation", async () => {
    membersByUserId({ "actor-1": { role: "ADMIN" } });

    await revokeWorkspaceInvitation({
      workspaceId: "ws-1",
      actorId: "actor-1",
      invitationId: "inv-1",
      now: NOW,
    });

    expect(invitationUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "inv-1",
        workspaceId: "ws-1",
        acceptedAt: null,
        revokedAt: null,
      },
      data: { revokedAt: NOW },
    });
  });

  it("transfers ownership by demoting the owner, then promoting the target", async () => {
    membersByUserId({ "actor-1": { role: "OWNER" }, "member-1": { role: "MEMBER" } });

    expect(
      await transferWorkspaceOwnership({
        workspaceId: "ws-1",
        actorId: "actor-1",
        targetUserId: "member-1",
      }),
    ).toBe("ok");

    expect(memberUpdateMany).toHaveBeenNthCalledWith(1, {
      where: { workspaceId: "ws-1", userId: "actor-1", role: "OWNER" },
      data: { role: "ADMIN" },
    });
    expect(memberUpdateMany).toHaveBeenNthCalledWith(2, {
      where: { workspaceId: "ws-1", userId: "member-1", role: "MEMBER" },
      data: { role: "OWNER" },
    });
  });

  it("refuses a transfer to oneself, by a non-owner, or to an owner", async () => {
    expect(
      await transferWorkspaceOwnership({
        workspaceId: "ws-1",
        actorId: "actor-1",
        targetUserId: "actor-1",
      }),
    ).toBe("forbidden");

    membersByUserId({ "actor-1": { role: "ADMIN" }, "member-1": { role: "MEMBER" } });
    expect(
      await transferWorkspaceOwnership({
        workspaceId: "ws-1",
        actorId: "actor-1",
        targetUserId: "member-1",
      }),
    ).toBe("forbidden");

    membersByUserId({ "actor-1": { role: "OWNER" }, "owner-2": { role: "OWNER" } });
    expect(
      await transferWorkspaceOwnership({
        workspaceId: "ws-1",
        actorId: "actor-1",
        targetUserId: "owner-2",
      }),
    ).toBe("forbidden");

    expect(memberUpdateMany).not.toHaveBeenCalled();
  });

  it("rolls the demotion back when the target changed before promotion", async () => {
    membersByUserId({ "actor-1": { role: "OWNER" }, "member-1": { role: "MEMBER" } });
    memberUpdateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });

    expect(
      await transferWorkspaceOwnership({
        workspaceId: "ws-1",
        actorId: "actor-1",
        targetUserId: "member-1",
      }),
    ).toBe("not_found");
  });
});

describe("workspace member listing", () => {
  beforeEach(() => {
    memberFindMany.mockReset();
  });

  it("maps rows to plain members without selecting credentials", async () => {
    memberFindMany.mockResolvedValue([
      {
        id: "wm-1",
        userId: "user-1",
        role: "OWNER",
        createdAt: NOW,
        user: { email: "person@example.test", name: "Camille" },
      },
    ]);

    expect(await listWorkspaceMembers("ws-1")).toEqual([
      {
        id: "wm-1",
        userId: "user-1",
        role: "OWNER",
        email: "person@example.test",
        name: "Camille",
        joinedAt: NOW,
      },
    ]);

    const query = memberFindMany.mock.calls[0][0];
    expect(query.where).toEqual({ workspaceId: "ws-1" });
    expect(JSON.stringify(query.select)).not.toMatch(/password|hash/i);
  });
});
