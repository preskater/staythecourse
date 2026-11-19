import { createHash } from "node:crypto";
import { looksLikeSecret } from "@/modules/ai-costs/source";

/**
 * Agent configuration and its fingerprint (M13-01). Pure, no I/O.
 *
 * A version is identified by what changes an agent's behaviour: its model policy,
 * tools, owner and repository scopes. Name and status are not configuration.
 *
 * Fingerprint, documented once here:
 * 1. Canonical form: tools and repository scopes are de-duplicated and sorted
 *    (their order means nothing); fallback models keep their order (it is the order
 *    they are tried in); object keys are sorted at every level.
 * 2. `fingerprint = sha256("agent-config/v1\n" + JSON of the canonical form)`, in
 *    lowercase hex. The prefix versions the recipe: changing it later must use
 *    `v2`, never silently re-hash old versions.
 *
 * Two configurations with the same fingerprint are the same configuration, so
 * saving an unchanged agent creates no version.
 */

export const AGENT_STATUSES = ["ACTIVE", "PAUSED", "RETIRED"] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

export const AGENT_STATUS_LABELS: Record<AgentStatus, string> = {
  ACTIVE: "Actif",
  PAUSED: "En pause",
  RETIRED: "Retiré",
};

export const MAX_AGENT_NAME_LENGTH = 120;
export const MAX_FALLBACK_MODELS = 10;
export const MAX_AGENT_TOOLS = 50;
export const MAX_REPOSITORY_SCOPES = 100;
export const FINGERPRINT_PREFIX = "agent-config/v1\n";

const PROVIDER_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/;
const TOOL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)+$/;
const MAX_REPOSITORY_LENGTH = 200;
const MAX_OWNER_LENGTH = 128;
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;

export class InvalidAgentConfigError extends Error {
  constructor(
    readonly field: string,
    reason: string,
  ) {
    super(`Invalid agent ${field}: ${reason}`);
    this.name = "InvalidAgentConfigError";
  }
}

export type ModelRef = { readonly provider: string; readonly model: string };

export type ModelPolicy = {
  readonly primary: ModelRef;
  /** Tried in this order when the primary model is unavailable. */
  readonly fallbacks: readonly ModelRef[];
};

export type AgentConfig = {
  readonly modelPolicy: ModelPolicy;
  readonly tools: readonly string[];
  readonly ownerId: string;
  readonly repositoryScopes: readonly string[];
};

export type AgentConfigInput = {
  modelPolicy: { primary: unknown; fallbacks?: unknown };
  tools?: unknown;
  ownerId: unknown;
  repositoryScopes?: unknown;
};

function text(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new InvalidAgentConfigError(field, "expected text");
  }

  return value.trim();
}

export function validateAgentName(value: unknown): string {
  const name = text(value, "name");

  if (name === "") throw new InvalidAgentConfigError("name", "is required");
  if (name.length > MAX_AGENT_NAME_LENGTH) {
    throw new InvalidAgentConfigError("name", `at most ${MAX_AGENT_NAME_LENGTH} characters`);
  }
  if (CONTROL_CHARACTERS.test(name)) {
    throw new InvalidAgentConfigError("name", "contains control characters");
  }

  return name;
}

export function validateAgentStatus(value: unknown): AgentStatus {
  if (typeof value !== "string" || !(AGENT_STATUSES as readonly string[]).includes(value)) {
    throw new InvalidAgentConfigError("status", "unknown status");
  }

  return value as AgentStatus;
}

function modelRef(value: unknown, field: string): ModelRef {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidAgentConfigError(field, "expected { provider, model }");
  }

  const source = value as Record<string, unknown>;
  const provider = text(source.provider, `${field}.provider`).toLowerCase();
  const model = text(source.model, `${field}.model`);

  if (!PROVIDER_PATTERN.test(provider)) {
    throw new InvalidAgentConfigError(`${field}.provider`, "expected a provider identifier");
  }
  if (!MODEL_PATTERN.test(model)) {
    throw new InvalidAgentConfigError(`${field}.model`, "expected a model identifier");
  }

  return Object.freeze({ provider, model });
}

function list(value: unknown, field: string, max: number): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new InvalidAgentConfigError(field, "expected a list");
  if (value.length > max) throw new InvalidAgentConfigError(field, `at most ${max} items`);
  return value.map((item, index) => text(item, `${field}[${index}]`));
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

/** Validates and normalises a configuration into its canonical form. */
export function validateAgentConfig(input: AgentConfigInput): AgentConfig {
  if (typeof input !== "object" || input === null) {
    throw new InvalidAgentConfigError("config", "expected an object");
  }

  const policy = input.modelPolicy;
  if (typeof policy !== "object" || policy === null) {
    throw new InvalidAgentConfigError("modelPolicy", "expected an object");
  }

  const primary = modelRef(policy.primary, "modelPolicy.primary");
  const rawFallbacks = policy.fallbacks ?? [];
  if (!Array.isArray(rawFallbacks)) {
    throw new InvalidAgentConfigError("modelPolicy.fallbacks", "expected a list");
  }
  if (rawFallbacks.length > MAX_FALLBACK_MODELS) {
    throw new InvalidAgentConfigError("modelPolicy.fallbacks", `at most ${MAX_FALLBACK_MODELS} models`);
  }

  const seen = new Set([`${primary.provider}/${primary.model}`]);
  const fallbacks = rawFallbacks.map((item, index) => {
    const ref = modelRef(item, `modelPolicy.fallbacks[${index}]`);
    const key = `${ref.provider}/${ref.model}`;
    if (seen.has(key)) {
      throw new InvalidAgentConfigError(`modelPolicy.fallbacks[${index}]`, "model already listed");
    }
    seen.add(key);
    return ref;
  });

  const tools = sortedUnique(list(input.tools, "tools", MAX_AGENT_TOOLS));
  for (const tool of tools) {
    if (!TOOL_PATTERN.test(tool)) throw new InvalidAgentConfigError("tools", `invalid tool "${tool}"`);
  }

  const repositoryScopes = sortedUnique(list(input.repositoryScopes, "repositoryScopes", MAX_REPOSITORY_SCOPES));
  for (const scope of repositoryScopes) {
    if (scope.length > MAX_REPOSITORY_LENGTH || !REPOSITORY_PATTERN.test(scope)) {
      throw new InvalidAgentConfigError("repositoryScopes", "expected owner/repository names");
    }
    if (looksLikeSecret(scope)) {
      throw new InvalidAgentConfigError("repositoryScopes", "looks like a credential, not a repository");
    }
  }

  const ownerId = text(input.ownerId, "ownerId");
  if (ownerId === "" || ownerId.length > MAX_OWNER_LENGTH || CONTROL_CHARACTERS.test(ownerId)) {
    throw new InvalidAgentConfigError("ownerId", "expected a member identifier");
  }

  return Object.freeze({
    modelPolicy: Object.freeze({ primary, fallbacks: Object.freeze(fallbacks) }),
    tools: Object.freeze(tools),
    ownerId,
    repositoryScopes: Object.freeze(repositoryScopes),
  });
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** SHA-256 of the canonical configuration; validates first, so equal inputs hash equally. */
export function agentConfigFingerprint(input: AgentConfigInput | AgentConfig): string {
  const config = validateAgentConfig(input as AgentConfigInput);
  return createHash("sha256").update(FINGERPRINT_PREFIX + canonicalJson(config)).digest("hex");
}
