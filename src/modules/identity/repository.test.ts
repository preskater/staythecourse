import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The seed's writes must be safe to repeat on every `up`.
 *
 * The database is mocked: what matters here is that the password hash replacement and
 * the session revocation are written together and scoped to the owner, and that the
 * workspace bootstrap only ever inserts — an existing name, and a module the owner
 * disabled, must survive a second run.
 */

const updateUserMock = vi.fn();
const updateSessionMock = vi.fn();
const upsertWorkspaceMock = vi.fn();
const upsertMemberMock = vi.fn();
const createManyModulesMock = vi.fn();
const updateModuleMock = vi.fn();
const transactionMock = vi.fn();

const prisma = {
  user: { updateMany: updateUserMock },
  session: { updateMany: updateSessionMock },
  workspace: { upsert: upsertWorkspaceMock },
  workspaceMember: { upsert: upsertMemberMock },
  workspaceModule: { createMany: createManyModulesMock, update: updateModuleMock },
  $transaction: transactionMock,
};

vi.mock("@/lib/db", () => ({ getPrisma: () => prisma }));

const { ensureDefaultWorkspace, updateOwnerPassword } = await import("./repository");

describe("updateOwnerPassword", () => {
  beforeEach(() => {
    updateUserMock.mockReset().mockResolvedValue({ count: 1 });
    updateSessionMock.mockReset().mockResolvedValue({ count: 2 });
    transactionMock
      .mockReset()
      .mockImplementation(async (arg: unknown) =>
        typeof arg === "function"
          ? (arg as (tx: typeof prisma) => Promise<unknown>)(prisma)
          : Promise.all(arg as Promise<unknown>[]),
      );
  });

  it("replaces the hash and revokes every active session in one transaction", async () => {
    expect(await updateOwnerPassword("owner-1", "$2b$12$replacement")).toBe(true);

    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(updateUserMock).toHaveBeenCalledWith({
      where: { id: "owner-1" },
      data: { passwordHash: "$2b$12$replacement" },
    });
    expect(updateSessionMock).toHaveBeenCalledWith({
      where: { userId: "owner-1", revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });

  it("reports an owner row that no longer exists instead of answering success", async () => {
    updateUserMock.mockResolvedValue({ count: 0 });

    expect(await updateOwnerPassword("recreated-away", "$2b$12$replacement")).toBe(false);
  });
});

describe("ensureDefaultWorkspace", () => {
  beforeEach(() => {
    upsertWorkspaceMock.mockReset().mockResolvedValue({ id: "ws-owner-1" });
    upsertMemberMock.mockReset().mockResolvedValue({ id: "wm-owner-1" });
    createManyModulesMock.mockReset().mockResolvedValue({ count: 2 });
    updateModuleMock.mockReset();
    transactionMock
      .mockReset()
      .mockImplementation(async (arg: unknown) =>
        typeof arg === "function"
          ? (arg as (tx: typeof prisma) => Promise<unknown>)(prisma)
          : Promise.all(arg as Promise<unknown>[]),
      );
  });

  it("creates the personal workspace, the owner membership and the selected modules", async () => {
    const result = await ensureDefaultWorkspace("owner-1", {
      name: "Foyer",
      modules: ["budget", "real-estate"],
    });

    expect(result).toEqual({ workspaceId: "ws-owner-1", addedModules: 2 });
    expect(upsertWorkspaceMock).toHaveBeenCalledWith({
      where: { id: "ws-owner-1" },
      create: { id: "ws-owner-1", name: "Foyer", kind: "PERSONAL" },
      update: {},
    });
    expect(upsertMemberMock).toHaveBeenCalledWith({
      where: { workspaceId_userId: { workspaceId: "ws-owner-1", userId: "owner-1" } },
      create: { id: "wm-owner-1", workspaceId: "ws-owner-1", userId: "owner-1", role: "OWNER" },
      update: {},
    });
    expect(createManyModulesMock).toHaveBeenCalledWith({
      data: [
        { workspaceId: "ws-owner-1", moduleKey: "budget" },
        { workspaceId: "ws-owner-1", moduleKey: "real-estate" },
      ],
      skipDuplicates: true,
    });
  });

  it("never rewrites what an existing workspace already has", async () => {
    // Empty updates and `skipDuplicates`: a second `up` keeps the workspace name, and
    // a module disabled from the Modules page, exactly as they are.
    createManyModulesMock.mockResolvedValue({ count: 0 });

    expect(await ensureDefaultWorkspace("owner-1", { name: "Foyer" })).toEqual({
      workspaceId: "ws-owner-1",
      addedModules: 0,
    });
    expect(upsertWorkspaceMock.mock.calls[0][0].update).toEqual({});
    expect(upsertMemberMock.mock.calls[0][0].update).toEqual({});
    expect(createManyModulesMock.mock.calls[0][0].skipDuplicates).toBe(true);
    expect(updateModuleMock).not.toHaveBeenCalled();
  });

  it("falls back to the default name and module set", async () => {
    await ensureDefaultWorkspace("owner-1");

    expect(upsertWorkspaceMock.mock.calls[0][0].create.name).toBe("Personnel");
    expect(createManyModulesMock.mock.calls[0][0].data).toEqual(
      ["budget", "real-estate", "development"].map((moduleKey) => ({
        workspaceId: "ws-owner-1",
        moduleKey,
      })),
    );
  });

  it("writes no module row when the selection is empty", async () => {
    expect(await ensureDefaultWorkspace("owner-1", { modules: [] })).toEqual({
      workspaceId: "ws-owner-1",
      addedModules: 0,
    });
    expect(createManyModulesMock).not.toHaveBeenCalled();
  });
});
