import { isUniqueConstraintError } from "@/lib/actions";
import { getPrisma } from "@/lib/db";
import { activeModules, DEFAULT_MODULES } from "@/modules/catalog/catalog";
import { invitationStatus } from "@/modules/identity/invitations";
import {
  canChangeMemberRole,
  canGrantRole,
  canRemoveMember,
  hasPermission,
} from "@/modules/identity/permissions";
import {
  type ActiveWorkspace,
  defaultWorkspaceId,
  type WorkspaceRole,
} from "@/modules/identity/workspace";

/**
 * Identity module.
 *
 * The dashboard has a single owner and no public sign-up: accounts are created
 * by the seed script, never by a web form.
 */

export type OwnerAccount = {
  id: string;
  email: string;
  name: string | null;
  passwordHash: string;
};

/** Addresses are stored and compared in lower case so `Owner@` and `owner@` match. */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function findOwnerByEmail(email: string): Promise<OwnerAccount | null> {
  const user = await getPrisma().user.findUnique({
    where: { email: normaliseEmail(email) },
    select: { id: true, email: true, name: true, passwordHash: true },
  });

  return user;
}

export async function findOwnerById(id: string): Promise<OwnerAccount | null> {
  return getPrisma().user.findUnique({
    where: { id },
    select: { id: true, email: true, name: true, passwordHash: true },
  });
}

export async function countOwners(): Promise<number> {
  return getPrisma().user.count();
}

/**
 * Replaces the password hash of one owner and revokes every active session.
 *
 * Both writes share one transaction: a change that committed the hash but not the
 * revocations would still be safe (the token fingerprint no longer matches), but the
 * account page would keep listing sessions that can never authenticate again.
 *
 * Scoped by identifier, and the number of written rows is returned: a session that
 * outlived its row (the database was recreated, or reset) would otherwise look
 * like a successful change while nothing at all was updated.
 */
export async function updateOwnerPassword(
  userId: string,
  passwordHash: string,
): Promise<boolean> {
  const prisma = getPrisma();
  const now = new Date();

  const [updated] = await prisma.$transaction([
    prisma.user.updateMany({
      where: { id: userId },
      data: { passwordHash },
    }),
    prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: now },
    }),
  ]);

  return updated.count === 1;
}

/**
 * Creates or updates the owner account. Used by the seed script only, so it is
 * idempotent: running it twice does not create a second account.
 */
export async function upsertOwner(input: {
  email: string;
  name: string;
  passwordHash: string;
}): Promise<{ id: string; email: string }> {
  const email = normaliseEmail(input.email);

  return getPrisma().user.upsert({
    where: { email },
    create: { email, name: input.name, passwordHash: input.passwordHash },
    update: { name: input.name, passwordHash: input.passwordHash },
    select: { id: true, email: true },
  });
}

/**
 * The user's memberships, oldest first: the order `resolveActiveWorkspace` relies on
 * for a stable default. Filtered by user, so another user's workspace never appears.
 */
export async function listMemberships(userId: string): Promise<ActiveWorkspace[]> {
  const rows = await getPrisma().workspaceMember.findMany({
    where: { userId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      role: true,
      workspace: {
        select: {
          id: true,
          name: true,
          kind: true,
          modules: { select: { moduleKey: true, enabled: true } },
        },
      },
    },
  });

  return rows.map(({ role, workspace: { modules, ...workspace } }) => ({
    ...workspace,
    role,
    modules: activeModules(modules),
  }));
}

/**
 * Gives the owner their personal workspace with the default modules. Used by the seed
 * script; idempotent and writes the same rows as the migration backfills, so neither
 * path duplicates the other. A module the owner disabled since stays disabled.
 */
export async function ensureDefaultWorkspace(userId: string): Promise<void> {
  const workspaceId = defaultWorkspaceId(userId);
  const prisma = getPrisma();

  await prisma.$transaction([
    prisma.workspace.upsert({
      where: { id: workspaceId },
      create: { id: workspaceId, name: "Personnel", kind: "PERSONAL" },
      update: {},
    }),
    prisma.workspaceMember.upsert({
      where: { workspaceId_userId: { workspaceId, userId } },
      create: { id: `wm-${userId}`, workspaceId, userId, role: "OWNER" },
      update: {},
    }),
    prisma.workspaceModule.createMany({
      data: DEFAULT_MODULES.map((moduleKey) => ({ workspaceId, moduleKey })),
      skipDuplicates: true,
    }),
  ]);
}

/* -------------------------------------------------------------------------- */
/* Invitations and membership lifecycle (M8-01)                                */
/* -------------------------------------------------------------------------- */

export type OpenInvitation = {
  id: string;
  email: string;
  role: WorkspaceRole;
  createdAt: Date;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
};

export type InvitationLookup = OpenInvitation & {
  workspaceId: string;
  workspaceName: string;
};

export type WorkspaceMemberRecord = {
  id: string;
  userId: string;
  email: string;
  name: string | null;
  role: WorkspaceRole;
  joinedAt: Date;
};

export type CreateInvitationResult =
  | { status: "ok"; id: string; replaced: number }
  | { status: "forbidden" }
  | { status: "already_member" };

/**
 * Creates an invitation for one address, replacing any live link for that same
 * address in the workspace.
 *
 * The previous revocation and the insert share one transaction: a re-invite leaves
 * exactly one usable link, never a set of them. The actor's role is re-read here
 * instead of trusting the session snapshot, so a role lowered by another admin cannot
 * be used to grant a role it no longer allows.
 */
export async function createWorkspaceInvitation(input: {
  workspaceId: string;
  actorId: string;
  email: string;
  role: WorkspaceRole;
  tokenHash: string;
  expiresAt: Date;
  now?: Date;
}): Promise<CreateInvitationResult> {
  const prisma = getPrisma();
  const now = input.now ?? new Date();
  const email = normaliseEmail(input.email);

  return prisma.$transaction(async (tx) => {
    const actor = await tx.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: input.workspaceId, userId: input.actorId } },
      select: { role: true },
    });

    if (!actor || !canGrantRole(actor.role as WorkspaceRole, input.role)) {
      return { status: "forbidden" as const };
    }

    const existingMember = await tx.workspaceMember.findFirst({
      where: { workspaceId: input.workspaceId, user: { email } },
      select: { id: true },
    });

    if (existingMember) {
      return { status: "already_member" as const };
    }

    const replaced = await tx.workspaceInvitation.updateMany({
      where: {
        workspaceId: input.workspaceId,
        email,
        acceptedAt: null,
        revokedAt: null,
        // Only a link that could still be used is revoked; an expired row already
        // reads as expired and stays in the list as such.
        expiresAt: { gt: now },
      },
      data: { revokedAt: now },
    });

    const created = await tx.workspaceInvitation.create({
      data: {
        workspaceId: input.workspaceId,
        email,
        role: input.role,
        tokenHash: input.tokenHash,
        invitedById: input.actorId,
        expiresAt: input.expiresAt,
      },
      select: { id: true },
    });

    // `replaced` is the number of older live links revoked by this invite; the action
    // records it so a silent replacement stays visible in the trail.
    return { status: "ok" as const, id: created.id, replaced: replaced.count };
  });
}

/** Invitations still awaiting a decision: pending, expired or revoked — not accepted. */
export async function listWorkspaceInvitations(
  workspaceId: string,
  take = 50,
): Promise<OpenInvitation[]> {
  const rows = await getPrisma().workspaceInvitation.findMany({
    where: { workspaceId, acceptedAt: null },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: Math.min(Math.max(take, 1), 100),
    select: {
      id: true,
      email: true,
      role: true,
      createdAt: true,
      expiresAt: true,
      acceptedAt: true,
      revokedAt: true,
    },
  });

  return rows.map((row) => ({ ...row, role: row.role as WorkspaceRole }));
}

/**
 * Revokes a live invitation. Accepted and already-revoked rows are left untouched:
 * revocation is about a link that can still be used, not about rewriting history.
 */
export async function revokeWorkspaceInvitation(input: {
  workspaceId: string;
  actorId: string;
  invitationId: string;
  now?: Date;
}): Promise<MembershipChangeResult> {
  const now = input.now ?? new Date();

  return getPrisma().$transaction(async (tx) => {
    const actor = await tx.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: input.workspaceId, userId: input.actorId } },
      select: { role: true },
    });

    if (!actor || !hasPermission(actor.role as WorkspaceRole, "manage-members")) {
      return "forbidden" as const;
    }

    const revoked = await tx.workspaceInvitation.updateMany({
      where: {
        id: input.invitationId,
        workspaceId: input.workspaceId,
        acceptedAt: null,
        revokedAt: null,
      },
      data: { revokedAt: now },
    });

    return revoked.count === 1 ? ("ok" as const) : ("not_found" as const);
  });
}

/**
 * Bearer-token lookup: this is the one invitation read that is not workspace-scoped,
 * because the token itself is the secret the holder presents. It returns the
 * workspace name for display only — never another member's data.
 */
export async function findWorkspaceInvitationByTokenHash(
  tokenHash: string,
): Promise<InvitationLookup | null> {
  const invitation = await getPrisma().workspaceInvitation.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      workspaceId: true,
      email: true,
      role: true,
      createdAt: true,
      expiresAt: true,
      acceptedAt: true,
      revokedAt: true,
      workspace: { select: { name: true } },
    },
  });

  if (!invitation) {
    return null;
  }

  const { workspace, ...rest } = invitation;

  return {
    ...rest,
    workspaceName: workspace.name,
    role: rest.role as WorkspaceRole,
  };
}

export type InvitationAcceptanceResult =
  | { status: "ok"; workspaceId: string }
  | { status: "invalid" }
  | { status: "email_mismatch" };

/**
 * Binds an invitation to the signed-in account and creates its membership.
 *
 * The conditional `updateMany` is what enforces single use under concurrency: the
 * expiry, revocation and acceptance checks are repeated in the `where`, so the loser
 * of a race writes no membership. An existing membership keeps its current role; an
 * invitation never escalates someone already in the workspace.
 */
export async function acceptWorkspaceInvitation(input: {
  tokenHash: string;
  userId: string;
  userEmail: string;
  now?: Date;
}): Promise<InvitationAcceptanceResult> {
  const prisma = getPrisma();
  const now = input.now ?? new Date();
  const email = normaliseEmail(input.userEmail);

  return prisma.$transaction(async (tx) => {
    const invitation = await tx.workspaceInvitation.findUnique({
      where: { tokenHash: input.tokenHash },
      select: {
        id: true,
        workspaceId: true,
        email: true,
        role: true,
        expiresAt: true,
        acceptedAt: true,
        revokedAt: true,
      },
    });

    if (!invitation || invitationStatus(invitation, now) !== "PENDING") {
      return { status: "invalid" as const };
    }

    if (invitation.email !== email) {
      return { status: "email_mismatch" as const };
    }

    const accepted = await tx.workspaceInvitation.updateMany({
      where: {
        id: invitation.id,
        acceptedAt: null,
        revokedAt: null,
        expiresAt: { gt: now },
      },
      data: { acceptedAt: now, acceptedByUserId: input.userId },
    });

    if (accepted.count !== 1) {
      return { status: "invalid" as const };
    }

    await tx.workspaceMember.upsert({
      where: { workspaceId_userId: { workspaceId: invitation.workspaceId, userId: input.userId } },
      create: {
        workspaceId: invitation.workspaceId,
        userId: input.userId,
        role: invitation.role,
      },
      update: {},
    });

    return { status: "ok" as const, workspaceId: invitation.workspaceId };
  });
}

export type InvitationRegistrationResult =
  | { status: "ok"; userId: string; workspaceId: string }
  | { status: "invalid" }
  | { status: "account_exists" };

/**
 * Creates the invited account and accepts the invitation in one transaction.
 *
 * The acceptance is consumed before the user row is written: a race on the same link
 * or a duplicate address rolls the whole transaction back, leaving the invitation
 * usable and no orphan account behind.
 */
export async function registerAndAcceptWorkspaceInvitation(input: {
  tokenHash: string;
  email: string;
  name: string | null;
  passwordHash: string;
  now?: Date;
}): Promise<InvitationRegistrationResult> {
  const prisma = getPrisma();
  const now = input.now ?? new Date();
  const email = normaliseEmail(input.email);

  try {
    return await prisma.$transaction(async (tx) => {
      const invitation = await tx.workspaceInvitation.findUnique({
        where: { tokenHash: input.tokenHash },
        select: {
          id: true,
          workspaceId: true,
          email: true,
          role: true,
          expiresAt: true,
          acceptedAt: true,
          revokedAt: true,
        },
      });

      if (!invitation || invitationStatus(invitation, now) !== "PENDING") {
        return { status: "invalid" as const };
      }

      if (invitation.email !== email) {
        return { status: "invalid" as const };
      }

      const accepted = await tx.workspaceInvitation.updateMany({
        where: {
          id: invitation.id,
          acceptedAt: null,
          revokedAt: null,
          expiresAt: { gt: now },
        },
        data: { acceptedAt: now },
      });

      if (accepted.count !== 1) {
        return { status: "invalid" as const };
      }

      const user = await tx.user.create({
        data: { email: invitation.email, name: input.name, passwordHash: input.passwordHash },
        select: { id: true },
      });

      await tx.workspaceInvitation.update({
        where: { id: invitation.id },
        data: { acceptedByUserId: user.id },
        select: { id: true },
      });

      await tx.workspaceMember.create({
        data: {
          workspaceId: invitation.workspaceId,
          userId: user.id,
          role: invitation.role,
        },
        select: { id: true },
      });

      return { status: "ok" as const, userId: user.id, workspaceId: invitation.workspaceId };
    });
  } catch (error) {
    // The unique address lost a creation race: the transaction rolled back, so the
    // caller can offer the sign-in path without a half-created membership.
    if (isUniqueConstraintError(error)) {
      return { status: "account_exists" };
    }
    throw error;
  }
}

export async function listWorkspaceMembers(workspaceId: string): Promise<WorkspaceMemberRecord[]> {
  const rows = await getPrisma().workspaceMember.findMany({
    where: { workspaceId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      userId: true,
      role: true,
      createdAt: true,
      user: { select: { email: true, name: true } },
    },
  });

  return rows.map(({ user, createdAt, ...row }) => ({
    ...row,
    role: row.role as WorkspaceRole,
    email: user.email,
    name: user.name,
    joinedAt: createdAt,
  }));
}

export type MembershipChangeResult = "ok" | "not_found" | "forbidden";

/**
 * Removes a membership. The owner can never be reached by this path, by anyone: the
 * permission matrix refuses it before the delete, and the delete repeats the target
 * role so a concurrent promotion cannot slip a newly promoted owner through.
 *
 * The removed person's sessions are left alone deliberately: the guard re-reads the
 * memberships on every request, so the removal is effective on the next one.
 */
export async function removeWorkspaceMember(input: {
  workspaceId: string;
  actorId: string;
  targetUserId: string;
}): Promise<MembershipChangeResult> {
  return getPrisma().$transaction(async (tx) => {
    const [actor, target] = await Promise.all([
      tx.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId: input.workspaceId, userId: input.actorId } },
        select: { role: true },
      }),
      tx.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId: input.workspaceId, userId: input.targetUserId } },
        select: { role: true },
      }),
    ]);

    if (!target) {
      return "not_found" as const;
    }

    if (!actor || !canRemoveMember(actor.role as WorkspaceRole, target.role as WorkspaceRole)) {
      return "forbidden" as const;
    }

    const removed = await tx.workspaceMember.deleteMany({
      where: {
        workspaceId: input.workspaceId,
        userId: input.targetUserId,
        role: target.role,
      },
    });

    return removed.count === 1 ? ("ok" as const) : ("not_found" as const);
  });
}

/** Changes a member's role within the matrix; `OWNER` is never a target role here. */
export async function changeWorkspaceMemberRole(input: {
  workspaceId: string;
  actorId: string;
  targetUserId: string;
  role: WorkspaceRole;
}): Promise<MembershipChangeResult> {
  return getPrisma().$transaction(async (tx) => {
    const [actor, target] = await Promise.all([
      tx.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId: input.workspaceId, userId: input.actorId } },
        select: { role: true },
      }),
      tx.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId: input.workspaceId, userId: input.targetUserId } },
        select: { role: true },
      }),
    ]);

    if (!target) {
      return "not_found" as const;
    }

    if (
      !actor ||
      !canChangeMemberRole(
        actor.role as WorkspaceRole,
        target.role as WorkspaceRole,
        input.role,
      )
    ) {
      return "forbidden" as const;
    }

    const updated = await tx.workspaceMember.updateMany({
      where: {
        workspaceId: input.workspaceId,
        userId: input.targetUserId,
        role: target.role,
      },
      data: { role: input.role },
    });

    return updated.count === 1 ? ("ok" as const) : ("not_found" as const);
  });
}

/** Thrown inside the transaction when the target changed before promotion, to roll back. */
class OwnershipTransferRace extends Error {}

/**
 * Transfers ownership explicitly: the current owner becomes an admin, the target
 * becomes the owner, in one transaction. The conditional demotion is the concurrency
 * guard — a second transfer started from the same owner reads `OWNER` no longer and
 * writes nothing. The owner can only reach this path by naming someone else.
 */
export async function transferWorkspaceOwnership(input: {
  workspaceId: string;
  actorId: string;
  targetUserId: string;
}): Promise<MembershipChangeResult> {
  if (input.actorId === input.targetUserId) {
    return "forbidden";
  }

  try {
    return await getPrisma().$transaction(async (tx) => {
      const [actor, target] = await Promise.all([
        tx.workspaceMember.findUnique({
          where: { workspaceId_userId: { workspaceId: input.workspaceId, userId: input.actorId } },
          select: { role: true },
        }),
        tx.workspaceMember.findUnique({
          where: { workspaceId_userId: { workspaceId: input.workspaceId, userId: input.targetUserId } },
          select: { role: true },
        }),
      ]);

      if (!actor || actor.role !== "OWNER") {
        return "forbidden" as const;
      }

      if (!target) {
        return "not_found" as const;
      }

      if (target.role === "OWNER") {
        return "forbidden" as const;
      }

      const demoted = await tx.workspaceMember.updateMany({
        where: { workspaceId: input.workspaceId, userId: input.actorId, role: "OWNER" },
        data: { role: "ADMIN" },
      });

      if (demoted.count !== 1) {
        return "forbidden" as const;
      }

      const promoted = await tx.workspaceMember.updateMany({
        where: {
          workspaceId: input.workspaceId,
          userId: input.targetUserId,
          role: target.role,
        },
        data: { role: "OWNER" },
      });

      if (promoted.count !== 1) {
        throw new OwnershipTransferRace();
      }

      return "ok" as const;
    });
  } catch (error) {
    if (error instanceof OwnershipTransferRace) {
      return "not_found";
    }
    throw error;
  }
}
