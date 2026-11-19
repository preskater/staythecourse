import "dotenv/config";
import { getPrisma } from "../src/lib/db";
import { selectModules } from "../src/modules/catalog/catalog";
import { normaliseEmail } from "../src/modules/identity/repository";
import { defaultWorkspaceId } from "../src/modules/identity/workspace";

/**
 * Checks the rows the seed must have produced, on a fresh or throwaway database.
 *
 * Run it after seeding twice (`npm run db:seed` followed by `npm run db:seed`): the
 * database must hold exactly one owner for `SEED_OWNER_EMAIL`, one personal workspace,
 * one `OWNER` membership and one row per selected module. That is the acceptance test
 * for "running the seed twice creates no duplicates" (M7-06); it is not meant for a
 * live workspace whose owner has since enabled or disabled modules on `/modules`.
 *
 * It reads the same `SEED_OWNER_EMAIL` and `SEED_WORKSPACE_MODULES` as the seed and
 * prints identifiers and module keys only, never a password or a secret.
 */
async function main(): Promise<void> {
  const email = process.env.SEED_OWNER_EMAIL;
  if (!email) {
    throw new Error("SEED_OWNER_EMAIL is required: it identifies the seeded owner.");
  }

  const selection = selectModules(process.env.SEED_WORKSPACE_MODULES);
  if (selection.status !== "ok") {
    throw new Error("SEED_WORKSPACE_MODULES is invalid; run `npm run db:seed` to see the exact reason.");
  }

  const prisma = getPrisma();
  const owners = await prisma.user.findMany({
    where: { email: normaliseEmail(email) },
    select: { id: true },
  });

  if (owners.length !== 1) {
    throw new Error(
      `Expected exactly one owner for ${normaliseEmail(email)}, found ${owners.length}.`,
    );
  }

  const ownerId = owners[0].id;
  const workspaceId = defaultWorkspaceId(ownerId);

  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { id: true },
  });
  if (!workspace) {
    throw new Error(`The personal workspace ${workspaceId} is missing.`);
  }

  const membership = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: ownerId } },
    select: { role: true },
  });
  if (membership?.role !== "OWNER") {
    throw new Error(`The owner is not a member of ${workspaceId} with the OWNER role.`);
  }

  const stored = await prisma.workspaceModule.findMany({
    where: { workspaceId },
    orderBy: { moduleKey: "asc" },
    select: { moduleKey: true, enabled: true },
  });

  const duplicate = stored.length !== new Set(stored.map((row) => row.moduleKey)).size;
  if (duplicate) {
    throw new Error(`Duplicate module rows found in ${workspaceId}.`);
  }

  const missing = selection.modules.filter(
    (key) => !stored.some((row) => row.moduleKey === key && row.enabled),
  );
  if (missing.length > 0) {
    throw new Error(`Modules missing or disabled in ${workspaceId}: ${missing.join(", ")}.`);
  }

  console.log(
    `Seed check OK: ${normaliseEmail(email)} → ${workspaceId} (OWNER), modules: ${selection.modules.join(", ")}`,
  );
  console.log(`Stored modules: ${stored.map((row) => `${row.moduleKey}=${row.enabled}`).join(", ")}`);
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => {
    // Nothing to close explicitly: the Prisma client is released with the process.
  });
