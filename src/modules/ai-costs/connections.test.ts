import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderError } from "@/modules/integrations/adapter";

/**
 * AI provider credential flows (M11-05): validation before saving, rotation that fails
 * closed, re-test, revocation, and redaction of the secret from every outcome, error
 * and audit entry. Repository and audit are faked; the secret is fictitious.
 */

const repository = {
  saveAiCredential: vi.fn(),
  recordAiValidation: vi.fn(),
  revokeAiCredential: vi.fn(),
  readAiCredential: vi.fn(),
};
vi.mock("./connections.repository", () => repository);

const auditMock = vi.fn(async (entry: unknown) => {
  void entry;
});
vi.mock("@/modules/audit/repository", () => ({ recordAuditEventSafely: auditMock }));

const { aiConnectionInputSchema, connectAiProvider, describeValidationError, revalidateAiConnection, revokeAiConnection } =
  await import("./connections");

const SECRET = "sk-or-v1-fictitious-management-secret";
const AT = new Date("2026-11-20T10:00:00Z");
const actor = { workspaceId: "ws-1", actorId: "user-1" };

function adapters(testAuth: (request: { token: string }) => Promise<{ accountLabel: string; grantedScopes: string[] | null }>) {
  const auth = { testAuth: vi.fn(testAuth) };
  return { auth, deps: { adapters: { OPENAI: auth, ANTHROPIC: auth, OPENROUTER: auth, CURSOR: auth }, now: () => AT } };
}

const accepted = () => adapters(async () => ({ accountLabel: "Compte OpenRouter", grantedScopes: null }));
const refused = (code: "UNAUTHORIZED" | "FORBIDDEN" | "RATE_LIMITED") =>
  adapters(async () => {
    throw new ProviderError(code, "Refus.");
  });

/** The secret must not appear in anything that leaves the flow. */
function expectNoSecret(...values: unknown[]) {
  const serialized = JSON.stringify([values, auditMock.mock.calls, repository.recordAiValidation.mock.calls]);
  expect(serialized).not.toContain(SECRET);
}

beforeEach(() => {
  vi.clearAllMocks();
  repository.saveAiCredential.mockResolvedValue({ id: "conn-1", rotated: false });
  repository.recordAiValidation.mockResolvedValue(true);
  repository.revokeAiCredential.mockResolvedValue(true);
});

describe("connectAiProvider", () => {
  it("tests the secret with the provider, then stores it and audits the connection", async () => {
    const { auth, deps } = accepted();
    const outcome = await connectAiProvider({ ...actor, provider: "OPENROUTER", secret: SECRET }, deps);

    expect(auth.testAuth).toHaveBeenCalledWith({ token: SECRET, instanceUrl: "" });
    expect(repository.saveAiCredential).toHaveBeenCalledWith("ws-1", expect.objectContaining({ provider: "OPENROUTER", token: SECRET, validatedAt: AT }));
    expect(outcome).toEqual({ status: "connected", connectionId: "conn-1" });
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "ai_connection.connect", outcome: "SUCCESS", entityId: "conn-1" }));
    expectNoSecret(outcome);
  });

  it("audits a replacement of an existing secret as a rotation", async () => {
    repository.saveAiCredential.mockResolvedValue({ id: "conn-1", rotated: true });
    const outcome = await connectAiProvider({ ...actor, provider: "OPENROUTER", secret: SECRET }, accepted().deps);

    expect(outcome.status).toBe("rotated");
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "ai_connection.rotate", outcome: "SUCCESS" }));
  });

  it("stores nothing when the provider refuses the secret: a failed rotation keeps the old one", async () => {
    const outcome = await connectAiProvider({ ...actor, provider: "OPENROUTER", secret: SECRET }, refused("FORBIDDEN").deps);

    expect(outcome).toEqual({ status: "rejected", code: "FORBIDDEN" });
    expect(repository.saveAiCredential).not.toHaveBeenCalled();
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "ai_connection.connect", outcome: "FAILED", metadata: expect.objectContaining({ error: "FORBIDDEN" }) }),
    );
    expectNoSecret(outcome);
  });

  it("reduces an unexpected error to a code, never reusing its message", async () => {
    const { deps } = adapters(async ({ token }) => {
      throw new Error(`boom with ${token}`);
    });
    const outcome = await connectAiProvider({ ...actor, provider: "OPENAI", secret: SECRET }, deps);

    expect(outcome).toEqual({ status: "rejected", code: "INTERNAL" });
    expect(repository.saveAiCredential).not.toHaveBeenCalled();
    expectNoSecret(outcome);
  });
});

describe("revalidateAiConnection", () => {
  const usable = { state: "usable", id: "conn-1", provider: "OPENROUTER", instanceUrl: "", token: SECRET };

  it("marks an accepted credential valid", async () => {
    repository.readAiCredential.mockResolvedValue(usable);
    const outcome = await revalidateAiConnection({ ...actor, connectionId: "conn-1" }, accepted().deps);

    expect(outcome).toEqual({ status: "valid" });
    expect(repository.recordAiValidation).toHaveBeenCalledWith("ws-1", "conn-1", expect.objectContaining({ ok: true, at: AT }));
    expect(repository.readAiCredential).toHaveBeenCalledWith("ws-1", "conn-1", { includeInvalid: true });
  });

  it.each(["UNAUTHORIZED", "FORBIDDEN"] as const)("marks a credential refused with %s invalid", async (code) => {
    repository.readAiCredential.mockResolvedValue(usable);
    const outcome = await revalidateAiConnection({ ...actor, connectionId: "conn-1" }, refused(code).deps);

    expect(outcome).toEqual({ status: "invalid", code });
    expect(repository.recordAiValidation).toHaveBeenCalledWith("ws-1", "conn-1", { ok: false, errorCode: code, at: AT });
    expectNoSecret(outcome);
  });

  it("leaves the state untouched on an outage: a rate limit is not a bad key", async () => {
    repository.readAiCredential.mockResolvedValue(usable);
    const outcome = await revalidateAiConnection({ ...actor, connectionId: "conn-1" }, refused("RATE_LIMITED").deps);

    expect(outcome).toEqual({ status: "unavailable", code: "RATE_LIMITED" });
    expect(repository.recordAiValidation).not.toHaveBeenCalled();
  });

  it("marks a secret the current key cannot decrypt invalid, without calling the provider", async () => {
    repository.readAiCredential.mockResolvedValue({ state: "unreadable", id: "conn-1", provider: "OPENROUTER" });
    const { auth, deps } = accepted();
    const outcome = await revalidateAiConnection({ ...actor, connectionId: "conn-1" }, deps);

    expect(outcome).toEqual({ status: "invalid", code: "UNREADABLE" });
    expect(auth.testAuth).not.toHaveBeenCalled();
  });

  it("does nothing for a revoked or unknown connection", async () => {
    const { auth, deps } = accepted();
    repository.readAiCredential.mockResolvedValueOnce({ state: "revoked", id: "conn-1", provider: "OPENROUTER" });
    expect(await revalidateAiConnection({ ...actor, connectionId: "conn-1" }, deps)).toEqual({ status: "revoked" });
    repository.readAiCredential.mockResolvedValueOnce(null);
    expect(await revalidateAiConnection({ ...actor, connectionId: "nope" }, deps)).toEqual({ status: "not_found" });
    expect(auth.testAuth).not.toHaveBeenCalled();
  });
});

describe("revokeAiConnection", () => {
  it("erases the secret and audits the revocation", async () => {
    const outcome = await revokeAiConnection({ ...actor, connectionId: "conn-1" }, { now: () => AT });

    expect(outcome).toEqual({ status: "revoked" });
    expect(repository.revokeAiCredential).toHaveBeenCalledWith("ws-1", "conn-1", AT);
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "ai_connection.revoke", outcome: "SUCCESS" }));
  });

  it("reports an unknown connection without auditing a revocation", async () => {
    repository.revokeAiCredential.mockResolvedValue(false);

    expect(await revokeAiConnection({ ...actor, connectionId: "nope" })).toEqual({ status: "not_found" });
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("fails closed: a storage error is audited and thrown, never reported as revoked", async () => {
    repository.revokeAiCredential.mockRejectedValue(new Error("database down"));

    await expect(revokeAiConnection({ ...actor, connectionId: "conn-1" })).rejects.toThrow("database down");
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "ai_connection.revoke", outcome: "FAILED" }));
  });
});

describe("aiConnectionInputSchema", () => {
  it.each([
    ["too short", "sk-1"],
    ["with a space", "sk-ant-admin01 with-space"],
  ])("rejects a secret %s without echoing it", (_label, secret) => {
    const result = aiConnectionInputSchema.safeParse({ provider: "ANTHROPIC", secret });

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues.map((issue) => issue.message))).not.toContain(secret);
  });

  it("accepts a known provider and trims the pasted secret", () => {
    expect(aiConnectionInputSchema.parse({ provider: "OPENAI", secret: `  ${SECRET}\n` })).toEqual({ provider: "OPENAI", secret: SECRET });
  });

  it("refuses a provider without a test adapter", () => {
    expect(aiConnectionInputSchema.safeParse({ provider: "CUSTOM", secret: SECRET }).success).toBe(false);
  });
});

describe("describeValidationError", () => {
  it("explains known codes and stays generic otherwise", () => {
    expect(describeValidationError(null)).toBeNull();
    expect(describeValidationError("UNAUTHORIZED")).toMatch(/refusée/);
    expect(describeValidationError("HTTP_ERROR")).toBe("Le fournisseur a répondu de façon inattendue.");
  });
});
