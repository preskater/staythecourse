import { getPrisma } from "@/lib/db";
import { activeModules, DEFAULT_MODULES, type ModuleKey } from "@/modules/catalog/catalog";
import { type ActiveWorkspace, defaultWorkspaceId } from "@/modules/identity/workspace";

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

export type DefaultWorkspaceOptions = {
  /** Name used when this run creates the workspace. An existing name is never rewritten. */
  name?: string;
  /** Modules inserted when this run creates the rows. Defaults to `DEFAULT_MODULES`. */
  modules?: readonly ModuleKey[];
};

export type DefaultWorkspaceResult = {
  workspaceId: string;
  /** Rows this run inserted; 0 when the workspace already had them, active or not. */
  addedModules: number;
};

/**
 * Gives the owner their personal workspace, the membership that makes it reachable and
 * the modules it starts with. Used by the seed script.
 *
 * Idempotent by construction: the workspace and the membership are upserted on the same
 * identifiers the migration backfills wrote, and the modules are inserted only when
 * missing. Neither path duplicates the other, and a module the owner disabled since
 * stays disabled, whatever the environment asks for on the next `up`. An existing
 * workspace keeps its own name for the same reason.
 */
export async function ensureDefaultWorkspace(
  userId: string,
  options: DefaultWorkspaceOptions = {},
): Promise<DefaultWorkspaceResult> {
  const workspaceId = defaultWorkspaceId(userId);
  const name = options.name?.trim() || "Personnel";
  const modules = options.modules ?? DEFAULT_MODULES;

  return getPrisma().$transaction(async (tx) => {
    await tx.workspace.upsert({
      where: { id: workspaceId },
      create: { id: workspaceId, name, kind: "PERSONAL" },
      update: {},
    });
    await tx.workspaceMember.upsert({
      where: { workspaceId_userId: { workspaceId, userId } },
      create: { id: `wm-${userId}`, workspaceId, userId, role: "OWNER" },
      update: {},
    });

    const added =
      modules.length === 0
        ? { count: 0 }
        : await tx.workspaceModule.createMany({
            data: modules.map((moduleKey) => ({ workspaceId, moduleKey })),
            skipDuplicates: true,
          });

    return { workspaceId, addedModules: added.count };
  });
}
