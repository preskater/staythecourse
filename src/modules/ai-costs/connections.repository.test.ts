import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * AI provider credentials at rest (M11-05), with the real AES-256-GCM helpers and a fake
 * table that honours `select` the way Prisma does: a column not selected never comes
 * back. The keys and secrets are fictitious.
 */

type Row = Record<string, unknown> & { id: string; workspaceId: string };
const rows: Row[] = [];
let nextId = 1;

function pick(row: Row, select?: Record<string, boolean>) {
  return select ? Object.fromEntries(Object.keys(select).map((key) => [key, row[key]])) : { ...row };
}

const matches = (row: Row, where: Record<string, unknown>) =>
  Object.entries(where).every(([key, value]) =>
    value !== null && typeof value === "object" && "not" in value ? row[key] !== value.not : row[key] === value,
  );

const prisma = {
  aiProviderConnection: {
    findMany: vi.fn(async (args: { where: Record<string, unknown>; select: Record<string, boolean> }) =>
      rows.filter((row) => matches(row, args.where)).map((row) => pick(row, args.select)),
    ),
    findFirst: vi.fn(async (args: { where: Record<string, unknown>; select: Record<string, boolean> }) => {
      const row = rows.find((candidate) => matches(candidate, args.where));
      return row ? pick(row, args.select) : null;
    }),
    upsert: vi.fn(async (args: { where: { workspaceId_provider_instanceUrl: Record<string, unknown> }; create: Row; update: Partial<Row>; select: Record<string, boolean> }) => {
      let row = rows.find((candidate) => matches(candidate, args.where.workspaceId_provider_instanceUrl));
      if (row) Object.assign(row, args.update);
      else rows.push((row = { status: "VALID", ...args.create, id: `conn-${nextId++}` }));
      return pick(row, args.select);
    }),
    updateMany: vi.fn(async (args: { where: Record<string, unknown>; data: Partial<Row> }) => {
      const hit = rows.filter((row) => matches(row, args.where));
      hit.forEach((row) => Object.assign(row, args.data));
      return { count: hit.length };
    }),
  },
};

const KEY = Buffer.alloc(32, 7).toString("base64");
let encryptionKey = KEY;

vi.mock("@/lib/db", () => ({ getPrisma: () => prisma }));
vi.mock("@/lib/env", () => ({ getServerEnv: () => ({ INTEGRATION_ENCRYPTION_KEY: encryptionKey }) }));

const { listAiConnections, readAiCredential, recordAiValidation, revokeAiCredential, saveAiCredential } = await import(
  "./connections.repository"
);

const SECRET = "sk-ant-admin01-fictitious-secret-value";
const AT = new Date("2026-11-20T10:00:00Z");

const save = (workspaceId = "ws-1", token = SECRET) =>
  saveAiCredential(workspaceId, {
    provider: "ANTHROPIC",
    instanceUrl: "",
    token,
    accountLabel: "Organisation Anthropic",
    grantedScopes: null,
    validatedAt: AT,
  });

beforeEach(() => {
  rows.length = 0;
  encryptionKey = KEY;
});

describe("saveAiCredential", () => {
  it("stores ciphertext only, which decrypts back to the secret", async () => {
    const { id } = await save();

    expect(rows[0].credentialsCiphertext).toMatch(/^v1\./);
    expect(JSON.stringify(rows)).not.toContain(SECRET);
    expect(await readAiCredential("ws-1", id)).toEqual({
      state: "usable",
      id,
      provider: "ANTHROPIC",
      instanceUrl: "",
      token: SECRET,
    });
  });

  it("rotates in place: one row, the old ciphertext overwritten, reported as a rotation", async () => {
    const first = await save();
    const previous = rows[0].credentialsCiphertext;
    const second = await save("ws-1", "sk-ant-admin01-the-new-secret");

    expect(first.rotated).toBe(false);
    expect(second).toEqual({ id: first.id, rotated: true });
    expect(rows).toHaveLength(1);
    expect(rows[0].credentialsCiphertext).not.toBe(previous);
    expect(JSON.stringify(rows)).not.toContain(SECRET);
  });
});

describe("listAiConnections", () => {
  it("returns metadata only: no secret, no ciphertext, not even selected", async () => {
    await save();
    const [summary] = await listAiConnections("ws-1");

    expect(summary).toMatchObject({ provider: "ANTHROPIC", status: "VALID", grantedScopes: null, lastValidatedAt: AT });
    expect(prisma.aiProviderConnection.findMany.mock.calls[0][0].select).not.toHaveProperty("credentialsCiphertext");
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain(rows[0].credentialsCiphertext as string);
  });

  it("never lists another workspace's connections", async () => {
    await save("ws-other");
    expect(await listAiConnections("ws-1")).toEqual([]);
  });
});

describe("revokeAiCredential and readAiCredential", () => {
  it("erases the ciphertext; the credential can no longer be read", async () => {
    const { id } = await save();

    expect(await revokeAiCredential("ws-1", id, AT)).toBe(true);
    expect(rows[0]).toMatchObject({ credentialsCiphertext: null, status: "REVOKED", revokedAt: AT });
    expect(await readAiCredential("ws-1", id)).toEqual({ state: "revoked", id, provider: "ANTHROPIC" });
  });

  it("cannot revoke or read a connection of another workspace", async () => {
    const { id } = await save("ws-other");

    expect(await revokeAiCredential("ws-1", id, AT)).toBe(false);
    expect(await readAiCredential("ws-1", id)).toBeNull();
    expect(rows[0].credentialsCiphertext).not.toBeNull();
  });

  it("gives no token for a credential refused at its last test, except to re-test it", async () => {
    const { id } = await save();
    await recordAiValidation("ws-1", id, { ok: false, errorCode: "UNAUTHORIZED", at: AT });

    expect(await readAiCredential("ws-1", id)).toEqual({ state: "invalid", id, provider: "ANTHROPIC" });
    expect(await readAiCredential("ws-1", id, { includeInvalid: true })).toMatchObject({ state: "usable", token: SECRET });
  });

  it("fails closed on a ciphertext the current key cannot read", async () => {
    const { id } = await save();
    encryptionKey = Buffer.alloc(32, 9).toString("base64");

    expect(await readAiCredential("ws-1", id)).toEqual({ state: "unreadable", id, provider: "ANTHROPIC" });
  });

  it("never revives a revoked connection through a validation result", async () => {
    const { id } = await save();
    await revokeAiCredential("ws-1", id, AT);

    expect(await recordAiValidation("ws-1", id, { ok: true, accountLabel: "x", grantedScopes: null, at: AT })).toBe(false);
    expect(rows[0].status).toBe("REVOKED");
  });
});
