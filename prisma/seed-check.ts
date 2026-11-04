import "dotenv/config";
import { getPrisma } from "../src/lib/db";
import { DEFAULT_MODULES, parseModuleSelection } from "../src/modules/catalog/catalog";
import { findOwnerByEmail, listMemberships } from "../src/modules/identity/repository";
import { defaultWorkspaceId, resolveActiveWorkspace } from "../src/modules/identity/workspace";

/**
 * Read-only check that the seed left a usable, unduplicated stack.
 *
 * Meant for a throwaway database: run `npm run db:seed` twice, then this script. A
 * second run must add nothing — one owner, one personal workspace, its owner
 * membership and the selected modules — and the workspace must be the one a request
 * resolves, which is what the dashboard needs to render at all.
 *
 * Nothing is written and nothing secret is printed, so it can also be run once against
 * a real single-owner instance. It asserts the deployment of today: several owners or
 * extra workspaces are what this check exists to catch.
 */
async function main(): Promise<void> {
  const email = process.env.SEED_OWNER_EMAIL;
  if (!email) {
    throw new Error("SEED_OWNER_EMAIL is required: it identifies the account the seed created.");
  }

  const selection = parseModuleSelection(
    process.env.SEED_WORKSPACE_MODULES ?? DEFAULT_MODULES.join(","),
  );
  if (selection.status !== "ok") {
    throw new Error(
      `SEED_WORKSPACE_MODULES is not a usable selection (${selection.status}): the seed would have refused it.`,
    );
  }

  const prisma = getPrisma();
  const failures: string[] = [];
  const expect = (condition: boolean, message: string): void => {
    if (!condition) {
      failures.push(message);
    }
  };

  const owner = await findOwnerByEmail(email);
  expect(owner !== null, `No owner account for ${email}.`);
  if (!owner) {
    report(failures);
    return;
  }

  const [owners, workspaces, memberships] = await Promise.all([
    prisma.user.count(),
    prisma.workspace.count(),
    prisma.workspaceMember.count(),
  ]);
  expect(owners === 1, `Expected 1 owner account, found ${owners}: the seed ran more than once?`);
  expect(
    workspaces === owners,
    `Expected one personal workspace per account, found ${workspaces} workspace(s) for ${owners} account(s).`,
  );
  expect(
    memberships === owners,
    `Expected one membership per account, found ${memberships} membership(s) for ${owners} account(s).`,
  );

  // What the application resolves on every request: without a membership the owner
  // signs in and reaches nothing.
  const workspace = resolveActiveWorkspace(await listMemberships(owner.id));
  expect(workspace !== null, "The owner has no membership: signing in reaches no workspace.");
  if (!workspace) {
    report(failures);
    return;
  }

  expect(
    workspace.id === defaultWorkspaceId(owner.id),
    `The owner resolves to ${workspace.id}, not to the personal workspace ${defaultWorkspaceId(owner.id)}.`,
  );
  expect(workspace.role === "OWNER", `The owner's membership grants ${workspace.role}, not OWNER.`);

  // The stored rows, not the active ones: a module the owner disabled holds a row with
  // `enabled: false` and is a working deployment, while a selected module with no row
  // at all means the seed never applied the selection.
  const stored = await prisma.workspaceModule.findMany({
    where: { workspaceId: workspace.id },
    select: { moduleKey: true },
  });
  const storedKeys = new Set(stored.map(({ moduleKey }) => moduleKey));
  const missing = selection.modules.filter((key) => !storedKeys.has(key));
  expect(
    missing.length === 0,
    `The workspace has no row for the selected module(s): ${missing.join(", ")}.`,
  );

  report(failures, `${workspace.id}; active: ${workspace.modules.join(", ") || "none"}`);
}

function report(failures: readonly string[], summary?: string): void {
  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`FAILED: ${failure}`);
    }
    process.exitCode = 1;
    return;
  }

  if (summary) {
    console.log(`Seed check passed: ${summary}.`);
  }
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => {
    // Nothing to close explicitly: the Prisma client is released with the process.
  });
