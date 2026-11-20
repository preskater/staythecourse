import { decodeEncryptionKey, decryptSecret, encryptSecret } from "@/lib/crypto";
import { getPrisma } from "@/lib/db";
import { getServerEnv } from "@/lib/env";
import type { AiConnectionSummary, AiProviderCode } from "./connections";

/**
 * Persistence of AI provider credentials (M11-05).
 *
 * The secret is encrypted before it is written (AES-256-GCM, `src/lib/crypto.ts`) and
 * only `readAiCredential` ever decrypts it, for server-side use. Every other function
 * selects explicit columns that never include the ciphertext, so a summary cannot leak
 * it even by accident. Every query is scoped to the workspace.
 */

function encryptionKey(): Buffer {
  return decodeEncryptionKey(getServerEnv().INTEGRATION_ENCRYPTION_KEY);
}

const SUMMARY = {
  id: true,
  provider: true,
  instanceUrl: true,
  accountLabel: true,
  grantedScopes: true,
  scopesReported: true,
  status: true,
  lastValidatedAt: true,
  lastValidationError: true,
  credentialUpdatedAt: true,
  revokedAt: true,
} as const;

export async function listAiConnections(workspaceId: string): Promise<AiConnectionSummary[]> {
  const rows = await getPrisma().aiProviderConnection.findMany({
    where: { workspaceId },
    orderBy: [{ provider: "asc" }, { instanceUrl: "asc" }],
    select: SUMMARY,
  });

  return rows.map((row) => ({
    ...row,
    provider: row.provider as AiProviderCode,
    grantedScopes: row.scopesReported ? row.grantedScopes : null,
  }));
}

/**
 * Stores a credential that has just passed its authentication test: first connection,
 * or rotation of the existing one for the same provider and instance. The previous
 * ciphertext is overwritten in the same statement, never kept alongside.
 */
export async function saveAiCredential(
  workspaceId: string,
  input: {
    provider: AiProviderCode;
    instanceUrl: string;
    token: string;
    accountLabel: string;
    /** `null` when the provider does not report permissions. */
    grantedScopes: string[] | null;
    validatedAt: Date;
  },
): Promise<{ id: string; rotated: boolean }> {
  const prisma = getPrisma();
  const key = { workspaceId, provider: input.provider, instanceUrl: input.instanceUrl };

  const existing = await prisma.aiProviderConnection.findFirst({
    where: key,
    select: { credentialsCiphertext: true },
  });

  const values = {
    credentialsCiphertext: encryptSecret(input.token, encryptionKey()),
    accountLabel: input.accountLabel,
    grantedScopes: input.grantedScopes ?? [],
    scopesReported: input.grantedScopes !== null,
    status: "VALID" as const,
    lastValidatedAt: input.validatedAt,
    lastValidationError: null,
    credentialUpdatedAt: input.validatedAt,
    revokedAt: null,
  };

  const saved = await prisma.aiProviderConnection.upsert({
    where: { workspaceId_provider_instanceUrl: key },
    create: { ...key, ...values },
    update: values,
    select: { id: true },
  });

  return { id: saved.id, rotated: Boolean(existing?.credentialsCiphertext) };
}

/** Outcome of a re-test of a stored credential. A revoked connection is never touched. */
export async function recordAiValidation(
  workspaceId: string,
  connectionId: string,
  result:
    | { ok: true; accountLabel: string; grantedScopes: string[] | null; at: Date }
    | { ok: false; errorCode: string; at: Date },
): Promise<boolean> {
  const data = result.ok
    ? {
        status: "VALID" as const,
        accountLabel: result.accountLabel,
        grantedScopes: result.grantedScopes ?? [],
        scopesReported: result.grantedScopes !== null,
        lastValidatedAt: result.at,
        lastValidationError: null,
      }
    : { status: "INVALID" as const, lastValidatedAt: result.at, lastValidationError: result.errorCode };

  const { count } = await getPrisma().aiProviderConnection.updateMany({
    where: { id: connectionId, workspaceId, status: { not: "REVOKED" } },
    data,
  });
  return count > 0;
}

/**
 * Destroys the stored secret: the ciphertext is erased, the row stays as a tombstone so
 * imported lines keep their connection and the history stays readable. Returns `false`
 * when no connection of the workspace has this id.
 */
export async function revokeAiCredential(workspaceId: string, connectionId: string, at: Date): Promise<boolean> {
  const { count } = await getPrisma().aiProviderConnection.updateMany({
    where: { id: connectionId, workspaceId },
    data: { credentialsCiphertext: null, status: "REVOKED", revokedAt: at },
  });
  return count > 0;
}

export type AiCredential =
  | { state: "usable"; id: string; provider: AiProviderCode; instanceUrl: string; token: string }
  | { state: "revoked" | "invalid" | "unreadable"; id: string; provider: AiProviderCode };

/**
 * Server-internal: the only function that decrypts a credential. Fails closed: only a
 * `VALID` connection yields a token; a revoked one, one the provider refused at its
 * last test, or a ciphertext the current key cannot read yields none.
 */
export async function readAiCredential(
  workspaceId: string,
  connectionId: string,
  /** Only for re-testing a refused credential: the test is the one use allowed. */
  options: { includeInvalid?: boolean } = {},
): Promise<AiCredential | null> {
  const row = await getPrisma().aiProviderConnection.findFirst({
    where: { id: connectionId, workspaceId },
    select: { id: true, provider: true, instanceUrl: true, status: true, credentialsCiphertext: true },
  });

  if (!row) return null;
  const provider = row.provider as AiProviderCode;
  if (row.status === "REVOKED" || !row.credentialsCiphertext) return { state: "revoked", id: row.id, provider };
  if (row.status === "INVALID" && !options.includeInvalid) return { state: "invalid", id: row.id, provider };

  try {
    const token = decryptSecret(row.credentialsCiphertext, encryptionKey());
    return { state: "usable", id: row.id, provider, instanceUrl: row.instanceUrl, token };
  } catch {
    // Written with another key or tampered with: unusable, never a crash or a guess.
    return { state: "unreadable", id: row.id, provider };
  }
}
