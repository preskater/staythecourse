import { beforeEach, describe, expect, it, vi } from "vitest";
import { passwordTag } from "@/lib/auth/password";
import type { WorkspaceRole } from "@/modules/identity/workspace";

const authMock = vi.fn();
const findActiveSessionMock = vi.fn();
const touchSessionMock = vi.fn();
const findOwnerByIdMock = vi.fn();
const listMembershipsMock = vi.fn();
const upsertConnectionMock = vi.fn();
const synchroniseConnectionMock = vi.fn();
const redirectMock = vi.fn();
const revalidatePathMock = vi.fn();

vi.mock("@/auth", () => ({ auth: () => authMock() }));
vi.mock("@/modules/identity/sessions", () => ({
  findActiveSession: (...args: unknown[]) => findActiveSessionMock(...args),
  touchSession: (...args: unknown[]) => touchSessionMock(...args),
}));
vi.mock("@/modules/identity/repository", () => ({
  findOwnerById: (...args: unknown[]) => findOwnerByIdMock(...args),
  listMemberships: (...args: unknown[]) => listMembershipsMock(...args),
}));
vi.mock("@/modules/integrations/repository", () => ({
  upsertConnection: (...args: unknown[]) => upsertConnectionMock(...args),
}));
vi.mock("@/jobs/sync", () => ({
  synchroniseConnection: (...args: unknown[]) => synchroniseConnectionMock(...args),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    redirectMock(url);
    throw new Error(`redirect:${url}`);
  },
  notFound: () => {
    throw new Error("not-found");
  },
}));
vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => revalidatePathMock(...args),
}));

const { connectProviderAction, syncConnectionAction } = await import("./actions");

/**
 * Forged direct calls to a write Server Action, through the real guard.
 *
 * Server Actions are public endpoints: the browser's hidden button is not a control.
 * A viewer's POST must reach no repository function, while a member's goes through.
 */
const owner = {
  id: "user-1",
  email: "owner@example.test",
  name: null,
  passwordHash: "$2b$12$action-test-hash",
};

const sessionRecord = {
  id: "session-1",
  lastSeenAt: new Date(),
  user: owner,
};

const validToken = {
  user: { id: owner.id, email: owner.email, name: owner.name },
  passwordTag: passwordTag(owner.passwordHash),
  sessionId: sessionRecord.id,
};

function membership(role: WorkspaceRole) {
  return {
    id: "ws-1",
    name: "Espace",
    kind: "PERSONAL",
    role,
    modules: ["development"],
  };
}

function connectionForm(): FormData {
  const form = new FormData();
  form.set("provider", "GITHUB");
  form.set("instanceUrl", "");
  form.set("externalOwner", "preskater");
  form.set("token", "fictitious-read-only-token");
  return form;
}

beforeEach(() => {
  authMock.mockReset().mockResolvedValue(validToken);
  findActiveSessionMock.mockReset().mockResolvedValue(sessionRecord);
  touchSessionMock.mockReset().mockResolvedValue(undefined);
  findOwnerByIdMock.mockReset().mockResolvedValue(owner);
  listMembershipsMock.mockReset().mockResolvedValue([membership("OWNER")]);
  upsertConnectionMock.mockReset().mockResolvedValue(undefined);
  synchroniseConnectionMock.mockReset().mockResolvedValue({ status: "SYNCHRONISED" });
  redirectMock.mockReset();
  revalidatePathMock.mockReset();
});

describe("forged Server Action calls", () => {
  it("refuses a viewer's connect attempt with a 404 and writes nothing", async () => {
    listMembershipsMock.mockResolvedValue([membership("VIEWER")]);

    await expect(connectProviderAction(connectionForm())).rejects.toThrow("not-found");

    expect(upsertConnectionMock).not.toHaveBeenCalled();
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("refuses a viewer's manual synchronisation and starts no run", async () => {
    listMembershipsMock.mockResolvedValue([membership("VIEWER")]);
    const form = new FormData();
    form.set("connectionId", "connection-1");

    await expect(syncConnectionAction(form)).rejects.toThrow("not-found");

    expect(synchroniseConnectionMock).not.toHaveBeenCalled();
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("lets a member connect, scoped to their own workspace", async () => {
    listMembershipsMock.mockResolvedValue([membership("MEMBER")]);

    await expect(connectProviderAction(connectionForm())).rejects.toThrow(
      "redirect:/integrations?status=connected",
    );

    expect(upsertConnectionMock).toHaveBeenCalledTimes(1);
    expect(upsertConnectionMock.mock.calls[0][0]).toMatchObject({
      workspaceId: "ws-1",
      provider: "GITHUB",
    });
  });
});
