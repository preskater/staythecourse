import { beforeEach, describe, expect, it, vi } from "vitest";
import { passwordTag } from "./password";

const authMock = vi.fn();
const findActiveSessionMock = vi.fn();
const touchSessionMock = vi.fn();
vi.mock("@/modules/identity/sessions", () => ({
  findActiveSession: (...args: unknown[]) => findActiveSessionMock(...args),
  touchSession: (...args: unknown[]) => touchSessionMock(...args),
}));
const findOwnerByIdMock = vi.fn();
const listMembershipsMock = vi.fn();

vi.mock("@/auth", () => ({ auth: () => authMock() }));
vi.mock("@/modules/identity/repository", () => ({
  findOwnerById: (id: string) => findOwnerByIdMock(id),
  listMemberships: (id: string) => listMembershipsMock(id),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`redirect:${url}`);
  },
  notFound: () => {
    throw new Error("not-found");
  },
}));

const { getSessionUser, requireApiAccess, requireModule, requirePermission, requireUser } =
  await import("./guard");

/** Fictitious owner only. */
const owner = {
  id: "user-1",
  email: "owner@example.test",
  name: "Proprietaire",
  passwordHash: "$2b$12$not-a-real-hash",
};

/** Persisted session row as the guard reads it, joined with its owner. */
const sessionRecord = {
  id: "session-1",
  lastSeenAt: new Date("2026-10-22T10:00:00Z"),
  user: owner,
};

/** A signed token: the JWT, plus the server-side session it names. */
const validSession = {
  user: { id: owner.id, email: owner.email, name: owner.name },
  passwordTag: passwordTag(owner.passwordHash),
  sessionId: sessionRecord.id,
};

/**
 * Fingerprint derived from the stored hash. It is what ties a token to the password
 * in force, so it is recomputed here rather than hard-coded.
 */
const CURRENT_TAG = passwordTag(owner.passwordHash);

/** The personal workspace the migration gives every existing owner. */
const personal = {
  id: "ws-user-1",
  name: "Personnel",
  kind: "PERSONAL",
  role: "OWNER",
  modules: ["budget", "real-estate", "development"],
};

describe("getSessionUser", () => {
  beforeEach(() => {
    authMock.mockReset();
    findActiveSessionMock.mockReset().mockResolvedValue(sessionRecord);
    touchSessionMock.mockReset().mockResolvedValue(undefined);
    findOwnerByIdMock.mockReset().mockResolvedValue(owner);
    listMembershipsMock.mockResolvedValue([personal]);
  });

  it("returns null without a session, without touching the database", async () => {
    authMock.mockResolvedValue(null);

    expect(await getSessionUser()).toBeNull();
    expect(findActiveSessionMock).not.toHaveBeenCalled();
  });

  it("returns null when the token carries no user id", async () => {
    authMock.mockResolvedValue({ user: { email: owner.email }, sessionId: "session-1" });

    expect(await getSessionUser()).toBeNull();
    expect(findActiveSessionMock).not.toHaveBeenCalled();
  });

  it("refuses a token issued before persisted sessions existed", async () => {
    // No session identifier: trusting it would bypass every revocation. The cost is
    // one sign-in.
    authMock.mockResolvedValue({
      user: { id: owner.id, email: owner.email },
      passwordTag: CURRENT_TAG,
    });

    expect(await getSessionUser()).toBeNull();
    expect(findActiveSessionMock).not.toHaveBeenCalled();
  });

  it("authenticates a valid session and records the visit", async () => {
    authMock.mockResolvedValue(validSession);

    expect(await getSessionUser()).toEqual({
      id: owner.id,
      email: owner.email,
      name: owner.name,
      sessionId: sessionRecord.id,
      workspace: personal,
    });
    // Both checks are scoped to the owner: a foreign row can never satisfy them.
    expect(findActiveSessionMock).toHaveBeenCalledWith(sessionRecord.id, owner.id);
    expect(touchSessionMock).toHaveBeenCalledWith(
      sessionRecord.id,
      owner.id,
      sessionRecord.lastSeenAt,
    );
    expect(findOwnerByIdMock).toHaveBeenCalledWith(owner.id);
    expect(listMembershipsMock).toHaveBeenCalledWith(owner.id);
  });

  it("refuses an owner without any workspace membership", async () => {
    authMock.mockResolvedValue({
      user: { id: owner.id, email: owner.email },
      passwordTag: CURRENT_TAG,
    });
    findOwnerByIdMock.mockResolvedValue(owner);
    listMembershipsMock.mockResolvedValue([]);

    expect(await getSessionUser()).toBeNull();
  });

  it("refuses a membership whose role does not grant even read access", async () => {
    // Deny-by-default: a role added later without a preset cannot open private pages
    // simply because the membership row exists.
    authMock.mockResolvedValue(validSession);
    listMembershipsMock.mockResolvedValue([{ ...personal, role: "AUDITOR" }]);

    expect(await getSessionUser()).toBeNull();
    expect(touchSessionMock).not.toHaveBeenCalled();
  });

  it("refuses a revoked session on the very next request", async () => {
    // The repository filters `revokedAt` out, so the row reads as missing.
    findActiveSessionMock.mockResolvedValue(null);
    authMock.mockResolvedValue(validSession);

    expect(await getSessionUser()).toBeNull();
    expect(touchSessionMock).not.toHaveBeenCalled();
  });

  it("refuses a token whose persisted session record is missing", async () => {
    findActiveSessionMock.mockResolvedValue(null);
    authMock.mockResolvedValue(validSession);

    expect(await getSessionUser()).toBeNull();
  });

  it("refuses a session owned by another account", async () => {
    // The lookup itself is scoped by owner; a foreign session id matches no row.
    findActiveSessionMock.mockResolvedValue(null);
    authMock.mockResolvedValue(validSession);

    expect(await getSessionUser()).toBeNull();
    expect(findActiveSessionMock).toHaveBeenCalledWith(sessionRecord.id, owner.id);
  });

  it("refuses a session whose owner row disappeared", async () => {
    // Deleting the owner cascades its sessions away: the joined lookup finds nothing.
    findActiveSessionMock.mockResolvedValue(null);
    authMock.mockResolvedValue(validSession);

    expect(await getSessionUser()).toBeNull();
  });

  it("treats a session issued before a password change as signed out", async () => {
    // The row is still there, but its hash is no longer the one this token was
    // issued for: the password was changed elsewhere, on another device.
    findActiveSessionMock.mockResolvedValue({
      ...sessionRecord,
      user: { ...owner, passwordHash: "$2b$12$a-previous-and-different-hash" },
    });
    authMock.mockResolvedValue(validSession);

    expect(await getSessionUser()).toBeNull();
    expect(touchSessionMock).not.toHaveBeenCalled();
  });

  it("refuses a token that carries no fingerprint, rather than trusting it", async () => {
    // Tokens issued before this check existed cannot be tied to the current
    // password: one extra sign-in is the price of refusing them.
    authMock.mockResolvedValue({
      user: { id: owner.id, email: owner.email },
      sessionId: sessionRecord.id,
    });

    expect(await getSessionUser()).toBeNull();
  });
});

describe("requireUser", () => {
  beforeEach(() => {
    authMock.mockReset();
    findActiveSessionMock.mockReset().mockResolvedValue(sessionRecord);
    touchSessionMock.mockReset().mockResolvedValue(undefined);
    findOwnerByIdMock.mockReset().mockResolvedValue(owner);
    listMembershipsMock.mockResolvedValue([personal]);
  });

  it("redirects an anonymous visitor to the sign-in page", async () => {
    authMock.mockResolvedValue(null);

    await expect(requireUser()).rejects.toThrow("redirect:/login");
  });

  it("redirects instead of letting a stale session reach a page", async () => {
    findActiveSessionMock.mockResolvedValue(null);
    authMock.mockResolvedValue(validSession);

    await expect(requireUser()).rejects.toThrow("redirect:/login");
  });

  it("lets the owner through", async () => {
    authMock.mockResolvedValue(validSession);

    await expect(requireUser()).resolves.toMatchObject({
      id: owner.id,
      sessionId: sessionRecord.id,
      workspace: { id: personal.id, role: "OWNER" },
    });
  });

  it("redirects an owner without any workspace membership", async () => {
    authMock.mockResolvedValue({
      user: { id: owner.id, email: owner.email },
      passwordTag: CURRENT_TAG,
    });
    findOwnerByIdMock.mockResolvedValue(owner);
    listMembershipsMock.mockResolvedValue([]);

    await expect(requireUser()).rejects.toThrow("redirect:/login");
  });
});

describe("requireModule", () => {
  beforeEach(() => {
    authMock.mockReset().mockResolvedValue(validSession);
    findActiveSessionMock.mockReset().mockResolvedValue(sessionRecord);
    touchSessionMock.mockReset().mockResolvedValue(undefined);
    findOwnerByIdMock.mockReset().mockResolvedValue(owner);
    listMembershipsMock.mockReset().mockResolvedValue([personal]);
  });

  it("returns the session user when the module is active in their workspace", async () => {
    expect((await requireModule("budget", "write")).workspace).toEqual(personal);
  });

  it("answers 404 when the module is not active in their workspace", async () => {
    listMembershipsMock.mockResolvedValue([{ ...personal, modules: ["real-estate"] }]);

    await expect(requireModule("budget", "write")).rejects.toThrow("not-found");
  });

  it("still redirects an anonymous visitor before looking at modules", async () => {
    authMock.mockResolvedValue(null);

    await expect(requireModule("budget", "write")).rejects.toThrow("redirect:/login");
  });

  it.each(["OWNER", "ADMIN", "MEMBER"])("lets a %s write", async (role) => {
    listMembershipsMock.mockResolvedValue([{ ...personal, role }]);

    await expect(requireModule("budget", "write")).resolves.toMatchObject({
      workspace: { role },
    });
  });

  it("refuses a viewer's forged write call with a 404 and writes nothing", async () => {
    listMembershipsMock.mockResolvedValue([{ ...personal, role: "VIEWER" }]);

    await expect(requireModule("budget", "write")).rejects.toThrow("not-found");
  });

  it("still lets a viewer read the module", async () => {
    listMembershipsMock.mockResolvedValue([{ ...personal, role: "VIEWER" }]);

    await expect(requireModule("budget", "read")).resolves.toMatchObject({
      workspace: { role: "VIEWER" },
    });
  });
});

describe("requirePermission", () => {
  beforeEach(() => {
    authMock.mockReset().mockResolvedValue(validSession);
    findActiveSessionMock.mockReset().mockResolvedValue(sessionRecord);
    touchSessionMock.mockReset().mockResolvedValue(undefined);
    findOwnerByIdMock.mockReset().mockResolvedValue(owner);
    listMembershipsMock.mockReset().mockResolvedValue([personal]);
  });

  it.each(["OWNER", "ADMIN", "MEMBER"])("lets a %s write outside a module", async (role) => {
    listMembershipsMock.mockResolvedValue([{ ...personal, role }]);

    await expect(requirePermission("write")).resolves.toMatchObject({
      workspace: { role },
    });
  });

  it("refuses a viewer's forged write with a 404", async () => {
    listMembershipsMock.mockResolvedValue([{ ...personal, role: "VIEWER" }]);

    await expect(requirePermission("write")).rejects.toThrow("not-found");
  });

  it("reserves module settings to owners and admins", async () => {
    listMembershipsMock.mockResolvedValue([{ ...personal, role: "ADMIN" }]);
    await expect(requirePermission("manage-modules")).resolves.toBeTruthy();

    listMembershipsMock.mockResolvedValue([{ ...personal, role: "MEMBER" }]);
    await expect(requirePermission("manage-modules")).rejects.toThrow("not-found");
  });

  it("redirects an anonymous visitor before checking the role", async () => {
    authMock.mockResolvedValue(null);

    await expect(requirePermission("write")).rejects.toThrow("redirect:/login");
  });
});

describe("requireApiAccess", () => {
  beforeEach(() => {
    authMock.mockReset().mockResolvedValue(validSession);
    findActiveSessionMock.mockReset().mockResolvedValue(sessionRecord);
    touchSessionMock.mockReset().mockResolvedValue(undefined);
    findOwnerByIdMock.mockReset().mockResolvedValue(owner);
    listMembershipsMock.mockReset().mockResolvedValue([personal]);
  });

  it("answers 401 JSON for an anonymous request", async () => {
    authMock.mockResolvedValue(null);

    const result = await requireApiAccess("export", "budget");

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(401);
    expect(await (result as Response).json()).toEqual({ error: "authentication_required" });
  });

  it.each(["OWNER", "ADMIN", "MEMBER"])("lets a %s export", async (role) => {
    listMembershipsMock.mockResolvedValue([{ ...personal, role }]);

    const result = await requireApiAccess("export", "budget");

    expect(result).toMatchObject({ workspace: { role } });
  });

  it("answers 403 JSON when a viewer requests an export", async () => {
    listMembershipsMock.mockResolvedValue([{ ...personal, role: "VIEWER" }]);

    const result = await requireApiAccess("export", "budget");

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(403);
    expect((result as Response).headers.get("Cache-Control")).toBe("no-store");
    expect(await (result as Response).json()).toEqual({ error: "forbidden" });
  });

  it("answers 403 JSON when a viewer exports alerts, which has no module gate", async () => {
    listMembershipsMock.mockResolvedValue([{ ...personal, role: "VIEWER" }]);

    const result = await requireApiAccess("export");

    expect((result as Response).status).toBe(403);
  });

  it("answers 404 for a disabled module before disclosing a role refusal", async () => {
    listMembershipsMock.mockResolvedValue([
      { ...personal, role: "VIEWER", modules: ["real-estate"] },
    ]);

    const result = await requireApiAccess("export", "budget");

    expect((result as Response).status).toBe(404);
  });
});
