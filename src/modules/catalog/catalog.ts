import { z } from "zod";

/**
 * Module catalog: the single source of truth for what a workspace can enable.
 *
 * Keys are stable identifiers stored in `WorkspaceModule.moduleKey`: never rename
 * one, add a new key instead. Anything not listed here is refused, whatever the
 * database or the browser says.
 *
 * Only `budget`, `real-estate` and `development` (the GitHub/GitLab integrations)
 * have pages today; the other keys reserve their identity for later milestones.
 * The dashboard, the alerts and the account page are not modules: every workspace
 * has them.
 */

export const MODULE_KEYS = [
  "budget",
  "real-estate",
  "development",
  "ai-costs",
  "agents",
  "micro-business",
  "profitability",
  "automation",
  "family",
] as const;

export type ModuleKey = (typeof MODULE_KEYS)[number];

export const moduleKeySchema = z.enum(MODULE_KEYS);

/** No module takes settings yet: unknown fields are refused rather than stored blindly. */
const noConfig = z.object({}).strict();

type ModuleDefinition = {
  label: string;
  /** Modules that must be active for this one to be. */
  requires: readonly ModuleKey[];
  /** Entry in the main navigation, for modules that have a page. */
  nav?: { href: string; label: string };
  config: z.ZodType<Record<string, unknown>>;
};

export const MODULE_CATALOG: Record<ModuleKey, ModuleDefinition> = {
  budget: { label: "Budget", requires: [], nav: { href: "/budget", label: "Budget" }, config: noConfig },
  "real-estate": {
    label: "Immobilier",
    requires: [],
    nav: { href: "/real-estate", label: "Immobilier" },
    config: noConfig,
  },
  development: {
    label: "Développement",
    requires: [],
    nav: { href: "/integrations", label: "Intégrations" },
    config: noConfig,
  },
  "ai-costs": { label: "Coûts IA", requires: [], config: noConfig },
  agents: { label: "Agents", requires: [], config: noConfig },
  "micro-business": { label: "Micro-entreprise", requires: [], config: noConfig },
  // Crosses rents, charges and the ledger: meaningless without both.
  profitability: { label: "Rentabilité", requires: ["budget", "real-estate"], config: noConfig },
  automation: { label: "Automatisation", requires: [], config: noConfig },
  family: { label: "Famille", requires: [], config: noConfig },
};

/** What every workspace that predates the catalog could already use (migration backfill). */
export const DEFAULT_MODULES: readonly ModuleKey[] = ["budget", "real-estate", "development"];

export function isModuleKey(value: unknown): value is ModuleKey {
  return moduleKeySchema.safeParse(value).success;
}

export type ModuleSelection =
  | { status: "ok"; modules: ModuleKey[] }
  | { status: "unknown_module"; keys: string[] }
  | { status: "missing_prerequisites"; missing: ModuleKey[] };

/**
 * Reads a comma- or space-separated list of module keys, as `SEED_WORKSPACE_MODULES`
 * does, into catalog-ordered keys.
 *
 * Unknown keys are reported together instead of being guessed at, and a prerequisite
 * left out of the same list is refused: storing only `profitability` would look
 * configured while `activeModules` switches it straight back off. An empty list is
 * accepted: a workspace may enable nothing at all.
 */
export function parseModuleSelection(raw: string): ModuleSelection {
  const requested = new Set(
    raw
      .split(/[\s,]+/)
      .map((key) => key.trim().toLowerCase())
      .filter((key) => key.length > 0),
  );

  const unknown = [...requested].filter((key) => !isModuleKey(key));
  if (unknown.length > 0) {
    return { status: "unknown_module", keys: unknown };
  }

  const modules = MODULE_KEYS.filter((key) => requested.has(key));
  const missing = new Set(
    modules.flatMap((key) => MODULE_CATALOG[key].requires.filter((required) => !requested.has(required))),
  );
  if (missing.size > 0) {
    return { status: "missing_prerequisites", missing: [...missing] };
  }

  return { status: "ok", modules };
}

/**
 * The modules a workspace can actually use, in catalog order: enabled, known, and with
 * every prerequisite active in turn. Disabling `budget` therefore switches
 * `profitability` off too, without touching its stored row.
 */
export function activeModules(
  rows: readonly { moduleKey: string; enabled: boolean }[],
): ModuleKey[] {
  const enabled = new Set(rows.filter((row) => row.enabled).map((row) => row.moduleKey));
  const isActive = (key: ModuleKey): boolean =>
    enabled.has(key) && MODULE_CATALOG[key].requires.every(isActive);

  return MODULE_KEYS.filter(isActive);
}

export function hasModule(workspace: { modules: readonly ModuleKey[] }, key: ModuleKey): boolean {
  return workspace.modules.includes(key);
}

/** Main navigation entries for the active modules, in catalog order. */
export function moduleNavLinks(modules: readonly ModuleKey[]): { href: string; label: string }[] {
  return modules.flatMap((key) => MODULE_CATALOG[key].nav ?? []);
}

export type ModuleChange =
  | { status: "ok"; key: ModuleKey; enabled: boolean; config?: Record<string, unknown> }
  | { status: "unknown_module" }
  | { status: "invalid_config"; issues: z.ZodError["issues"] }
  | { status: "missing_prerequisites"; missing: ModuleKey[] };

/**
 * Validates a request to enable or disable a module, sent from anywhere (form, script).
 *
 * - The key must be in the catalog.
 * - Enabling needs every prerequisite already active; disabling is always allowed and
 *   only deactivates the dependants.
 * - A configuration, when given, is checked against the module's own schema.
 */
export function validateModuleChange(
  input: { key: unknown; enabled: boolean; config?: unknown },
  active: readonly ModuleKey[],
): ModuleChange {
  const key = moduleKeySchema.safeParse(input.key);
  if (!key.success) {
    return { status: "unknown_module" };
  }

  const definition = MODULE_CATALOG[key.data];

  let config: Record<string, unknown> | undefined;
  if (input.config !== undefined) {
    const parsed = definition.config.safeParse(input.config);
    if (!parsed.success) {
      return { status: "invalid_config", issues: parsed.error.issues };
    }
    config = parsed.data;
  }

  if (input.enabled) {
    const missing = definition.requires.filter((required) => !active.includes(required));
    if (missing.length > 0) {
      return { status: "missing_prerequisites", missing };
    }
  }

  return { status: "ok", key: key.data, enabled: input.enabled, config };
}
