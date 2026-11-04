import "dotenv/config";
import { hashPassword } from "../src/lib/auth/password";
import { ensureCategory } from "../src/modules/budget/repository";
import { SALARY_CATEGORY_NAME } from "../src/modules/budget/salary";
import {
  DEFAULT_MODULES,
  MODULE_KEYS,
  parseModuleSelection,
  type ModuleKey,
} from "../src/modules/catalog/catalog";
import { PASSWORD_MIN_LENGTH } from "../src/modules/identity/domain";
import { defaultWorkspaceId } from "../src/modules/identity/workspace";
import {
  ensureDefaultWorkspace,
  findOwnerByEmail,
  upsertOwner,
} from "../src/modules/identity/repository";

/**
 * Module set the workspace starts with, from `SEED_WORKSPACE_MODULES`.
 *
 * An unusable value stops the run before anything is written: a typo in the
 * environment must not leave a workspace that boots with modules nobody can use.
 */
function selectedModules(): ModuleKey[] {
  const raw = process.env.SEED_WORKSPACE_MODULES ?? DEFAULT_MODULES.join(",");
  const selection = parseModuleSelection(raw);

  switch (selection.status) {
    case "ok":
      return selection.modules;
    case "unknown_module":
      throw new Error(
        `SEED_WORKSPACE_MODULES names modules the catalog does not know: ${selection.keys.join(", ")}. Known modules: ${MODULE_KEYS.join(", ")}.`,
      );
    case "missing_prerequisites":
      throw new Error(
        `SEED_WORKSPACE_MODULES enables a module without its prerequisites: ${selection.missing.join(", ")} must be listed too.`,
      );
  }
}

/**
 * Creates the single owner account, or refreshes the name of the one that exists, then
 * makes sure that owner can actually use the dashboard: a personal workspace, the
 * membership that reaches it and the modules it starts with.
 *
 * There is no public sign-up: this script is the only way an account appears.
 *
 * The environment password is written when the account is created. Once it has been
 * changed from the Compte page, this script keeps the stored hash instead of
 * overwriting it: the stack runs it on every `up`, and silently reverting a password
 * the owner has just chosen is a strange way to lose a credential.
 * `SEED_OWNER_FORCE_PASSWORD=true` puts the environment value back in force, which is
 * also the way out of a forgotten password.
 *
 * Running it again is a no-op on an existing stack: nothing is duplicated, the
 * workspace keeps the name and modules it has, and a module disabled from the
 * « Modules » page is never switched back on.
 *
 * Never seed real personal data here. The name and address below are
 * placeholders, and the password comes from the environment.
 */
async function main(): Promise<void> {
  const email = process.env.SEED_OWNER_EMAIL;
  const password = process.env.SEED_OWNER_PASSWORD;
  const name = process.env.SEED_OWNER_NAME ?? "Proprietaire";
  const forcePassword = process.env.SEED_OWNER_FORCE_PASSWORD === "true";

  if (!email || !password) {
    throw new Error(
      "SEED_OWNER_EMAIL and SEED_OWNER_PASSWORD are required. Copy .env.example to .env and set them locally.",
    );
  }

  const workspaceName = process.env.SEED_WORKSPACE_NAME?.trim() || "Personnel";
  const modules = selectedModules();

  const existing = await findOwnerByEmail(email);
  const keepsStoredPassword = existing !== null && !forcePassword;

  // Only checked when the value is actually about to be written: a short placeholder
  // must not fail a run that changes nothing.
  if (!keepsStoredPassword && password.length < PASSWORD_MIN_LENGTH) {
    throw new Error(
      `SEED_OWNER_PASSWORD must be at least ${PASSWORD_MIN_LENGTH} characters long: it protects the whole dashboard.`,
    );
  }

  const passwordHash = keepsStoredPassword
    ? existing.passwordHash
    : await hashPassword(password);
  const owner = await upsertOwner({ email, name, passwordHash });

  // Without a membership the owner could sign in but reach nothing (see `getSessionUser`).
  // The name and the module set below only apply when this run creates the rows: an
  // existing workspace keeps both, so a second run over a configured stack changes nothing.
  const workspace = await ensureDefaultWorkspace(owner.id, { name: workspaceName, modules });

  // The salary simulator books its income into a « Salaire » category: it is created here
  // so every owner has it from the start. The booking action also creates it on demand,
  // which covers owners seeded before this default existed. Never personal data: the
  // category is empty until the owner records something in it.
  await ensureCategory({ workspaceId: defaultWorkspaceId(owner.id), name: SALARY_CATEGORY_NAME, kind: "INCOME" });

  // Only identifiers and counts are printed: never the password, never the hash.
  console.log(
    keepsStoredPassword
      ? `Owner account ready: ${owner.email} (${owner.id}); stored password kept (set SEED_OWNER_FORCE_PASSWORD=true to overwrite it)`
      : `Owner account ready: ${owner.email} (${owner.id})`,
  );
  console.log(
    `Workspace ready: ${workspace.workspaceId}; ${modules.length} module(s) selected, ${workspace.addedModules} added by this run`,
  );
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => {
    // Nothing to close explicitly: the Prisma client is released with the process.
  });
