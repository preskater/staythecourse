import { z } from "zod";
import { recordAuditEventSafely } from "@/modules/audit/repository";
import type { AuditAction } from "@/modules/audit/domain";
import { ProviderError } from "@/modules/integrations/adapter";
import type { AiProviderAdapter } from "@/modules/integrations/ai-adapter";
import { anthropicAdapter } from "@/modules/integrations/anthropic";
import { openAiAdapter } from "@/modules/integrations/openai";
import { openRouterAdapter } from "@/modules/integrations/openrouter";
import {
  readAiCredential,
  recordAiValidation,
  revokeAiCredential,
  saveAiCredential,
} from "./connections.repository";

/**
 * AI provider credential management (M11-05).
 *
 * - A secret is submitted once, tested with the provider's adapter (`testAuth`) and
 *   stored encrypted only if the test passes. A refused secret is never stored: a
 *   failed rotation leaves the previous credential untouched.
 * - The browser only ever receives `AiConnectionSummary`: no secret, not even a
 *   prefix or a masked form.
 * - Revocation erases the ciphertext here. Read-only by design, the application never
 *   calls the provider to delete a key: the owner revokes it in the provider console.
 * - Connection, rotation, re-test and revocation each leave an audit entry with the
 *   provider and a safe code, never the secret.
 */

/** Providers with an adapter able to test a credential. `CUSTOM` has none yet. */
export const AI_CONNECTION_PROVIDERS = ["OPENAI", "ANTHROPIC", "OPENROUTER"] as const;
export type AiProviderCode = (typeof AI_CONNECTION_PROVIDERS)[number];

export const AI_CONNECTION_STATUSES = ["VALID", "INVALID", "REVOKED"] as const;
export type AiConnectionStatus = (typeof AI_CONNECTION_STATUSES)[number];

/** Everything the interface may show about a connection. Never the secret. */
export type AiConnectionSummary = {
  id: string;
  provider: AiProviderCode;
  instanceUrl: string;
  accountLabel: string | null;
  /** `null` when the provider does not report permissions: unknown, not "none". */
  grantedScopes: string[] | null;
  status: AiConnectionStatus;
  lastValidatedAt: Date | null;
  lastValidationError: string | null;
  credentialUpdatedAt: Date;
  revokedAt: Date | null;
};

export const AI_PROVIDER_LABELS: Record<AiProviderCode, { name: string; credential: string }> = {
  OPENAI: { name: "OpenAI", credential: "Clé admin de l'organisation, en lecture seule (usage et projets)" },
  ANTHROPIC: { name: "Anthropic", credential: "Clé Admin API de l'organisation" },
  OPENROUTER: { name: "OpenRouter", credential: "Clé de gestion (management key)" },
};

export const ADAPTERS: Record<AiProviderCode, AiProviderAdapter> = {
  OPENAI: openAiAdapter,
  ANTHROPIC: anthropicAdapter,
  OPENROUTER: openRouterAdapter,
};

/** French text for a safe error code; the code itself is what gets stored. */
export function describeValidationError(code: string | null): string | null {
  if (code === null) return null;
  const messages: Record<string, string> = {
    UNAUTHORIZED: "Clé refusée par le fournisseur (invalide ou révoquée).",
    FORBIDDEN: "Clé reconnue mais sans la permission de lire l'usage et les coûts.",
    RATE_LIMITED: "Fournisseur momentanément saturé : réessayez plus tard.",
    NETWORK: "Fournisseur injoignable : réessayez plus tard.",
    UNREADABLE: "Clé enregistrée illisible (clé de chiffrement changée) : remplacez-la.",
  };
  return messages[code] ?? "Le fournisseur a répondu de façon inattendue.";
}

/** The secret field is checked without ever being echoed in a message. */
export const aiConnectionInputSchema = z.object({
  provider: z.enum(AI_CONNECTION_PROVIDERS, { message: "Fournisseur inconnu." }),
  secret: z
    .string({ message: "Clé manquante." })
    .trim()
    .min(8, { message: "Clé trop courte." })
    .max(512, { message: "Clé trop longue." })
    .regex(/^\S+$/, { message: "La clé ne doit pas contenir d'espace." }),
});

export const aiConnectionIdSchema = z.string().min(1).max(64);

/** A provider refusal keeps its code; anything else is `INTERNAL`, so no message is reused. */
function safeCode(error: unknown): string {
  return error instanceof ProviderError ? error.code : "INTERNAL";
}

/** Codes meaning the provider rejected the credential itself, not a passing outage. */
const CREDENTIAL_REFUSED = new Set(["UNAUTHORIZED", "FORBIDDEN"]);

export type AiConnectionDependencies = {
  adapters: Record<AiProviderCode, Pick<AiProviderAdapter, "testAuth">>;
  now: () => Date;
};

const DEFAULTS: AiConnectionDependencies = { adapters: ADAPTERS, now: () => new Date() };

type Actor = { workspaceId: string; actorId: string };

function audit(
  actor: Actor,
  action: AuditAction,
  outcome: "SUCCESS" | "FAILED",
  entityId: string | null,
  metadata: Record<string, unknown>,
) {
  return recordAuditEventSafely({
    workspaceId: actor.workspaceId,
    actorId: actor.actorId,
    action,
    entityType: "INTEGRATION",
    entityId,
    outcome,
    metadata: { kind: "ai_provider", ...metadata },
  });
}

export type ConnectOutcome =
  | { status: "connected" | "rotated"; connectionId: string }
  | { status: "rejected"; code: string };

/** First connection or rotation: test first, store only a credential that passed. */
export async function connectAiProvider(
  input: Actor & { provider: AiProviderCode; secret: string },
  dependencies: Partial<AiConnectionDependencies> = {},
): Promise<ConnectOutcome> {
  const { adapters, now } = { ...DEFAULTS, ...dependencies };
  let auth;

  try {
    auth = await adapters[input.provider].testAuth({ token: input.secret, instanceUrl: "" });
  } catch (error) {
    const code = safeCode(error);
    await audit(input, "ai_connection.connect", "FAILED", null, { provider: input.provider, error: code });
    return { status: "rejected", code };
  }

  const saved = await saveAiCredential(input.workspaceId, {
    provider: input.provider,
    instanceUrl: "",
    token: input.secret,
    accountLabel: auth.accountLabel,
    grantedScopes: auth.grantedScopes,
    validatedAt: now(),
  });
  await audit(input, saved.rotated ? "ai_connection.rotate" : "ai_connection.connect", "SUCCESS", saved.id, {
    provider: input.provider,
  });

  return { status: saved.rotated ? "rotated" : "connected", connectionId: saved.id };
}

export type RevalidateOutcome =
  | { status: "valid" }
  | { status: "invalid"; code: string }
  | { status: "unavailable"; code: string }
  | { status: "revoked" | "not_found" };

/**
 * Re-tests a stored credential. Only a refusal of the credential itself (or a secret the
 * current key cannot decrypt) marks it invalid; an outage leaves the state as it was.
 */
export async function revalidateAiConnection(
  input: Actor & { connectionId: string },
  dependencies: Partial<AiConnectionDependencies> = {},
): Promise<RevalidateOutcome> {
  const { adapters, now } = { ...DEFAULTS, ...dependencies };
  const credential = await readAiCredential(input.workspaceId, input.connectionId, { includeInvalid: true });

  if (!credential) return { status: "not_found" };
  if (credential.state === "revoked") return { status: "revoked" };

  const meta = { provider: credential.provider };

  if (credential.state !== "usable") {
    await recordAiValidation(input.workspaceId, credential.id, { ok: false, errorCode: "UNREADABLE", at: now() });
    await audit(input, "ai_connection.validate", "FAILED", credential.id, { ...meta, error: "UNREADABLE" });
    return { status: "invalid", code: "UNREADABLE" };
  }

  try {
    const auth = await adapters[credential.provider].testAuth({
      token: credential.token,
      instanceUrl: credential.instanceUrl,
    });
    await recordAiValidation(input.workspaceId, credential.id, {
      ok: true,
      accountLabel: auth.accountLabel,
      grantedScopes: auth.grantedScopes,
      at: now(),
    });
    await audit(input, "ai_connection.validate", "SUCCESS", credential.id, meta);
    return { status: "valid" };
  } catch (error) {
    const code = safeCode(error);
    await audit(input, "ai_connection.validate", "FAILED", credential.id, { ...meta, error: code });

    if (!CREDENTIAL_REFUSED.has(code)) return { status: "unavailable", code };
    await recordAiValidation(input.workspaceId, credential.id, { ok: false, errorCode: code, at: now() });
    return { status: "invalid", code };
  }
}

export type RevokeOutcome = { status: "revoked" | "not_found" };

/**
 * Destroys the stored secret. Fails closed: a database error is audited and thrown, so
 * the interface never reports a revocation that did not happen.
 */
export async function revokeAiConnection(
  input: Actor & { connectionId: string },
  dependencies: Partial<AiConnectionDependencies> = {},
): Promise<RevokeOutcome> {
  const { now } = { ...DEFAULTS, ...dependencies };

  try {
    const revoked = await revokeAiCredential(input.workspaceId, input.connectionId, now());
    if (!revoked) return { status: "not_found" };
  } catch (error) {
    await audit(input, "ai_connection.revoke", "FAILED", input.connectionId, { error: "INTERNAL" });
    throw error;
  }

  await audit(input, "ai_connection.revoke", "SUCCESS", input.connectionId, {});
  return { status: "revoked" };
}
