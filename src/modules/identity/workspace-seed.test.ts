import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Seed idempotency for the personal workspace (M7-06).
 *
 * The fake client keeps the three tables in memory and applies the same keys as the
 * real schema: `Workspace.id`, `(workspaceId, userId)` and `(workspaceId, moduleKey)`.
 * Calling the seed helper twice must therefore leave exactly one row per key, and must
 * not rewrite a module activation the owner changed in the meantime.
 */

type WorkspaceRow = { id: string; name: string; kind: string };
type MemberRow = { id: string; workspaceId: string; userId: string; role: string };
type ModuleRow = { workspaceId: string; moduleKey: string; enabled: boolean };

const workspaces = new Map<string, WorkspaceRow>();
const members = new Map<string, MemberRow>();
const modules = new Map<string, ModuleRow>();

const moduleKey = (workspaceId: string, key: string) => `${workspaceId}\u0000${key}`;

const prisma = {
  workspace: {
    upsert: vi.fn(
      async ({ where, create, update }: { where: { id: string }; create: WorkspaceRow; update: Partial<WorkspaceRow> }) => {
        const existing = workspaces.get(where.id);
        if (existing) {
          Object.assign(existing, update);
          return existing;
        }
        workspaces.set(create.id, { ...create });
        return create;
      },
    ),
  },
  workspaceMember: {
    upsert: vi.fn(
      async ({
        where,
        create,
      }: {
        where: { workspaceId_userId: { workspaceId: string; userId: string } };
        create: MemberRow;
      }) => {
        const key = `${where.workspaceId_userId.workspaceId}\u0000${where.workspaceId_userId.userId}`;
        const existing = members.get(key);
        if (existing) return existing;
        members.set(key, { ...create });
        return create;
      },
    ),
  },
  workspaceModule: {
    createMany: vi.fn(
      async ({
        data,
        skipDuplicates,
      }: {
        data: { workspaceId: string; moduleKey: string }[];
        skipDuplicates?: boolean;
      }) => {
        let count = 0;
        for (const row of data) {
          const key = moduleKey(row.workspaceId, row.moduleKey);
          if (modules.has(key) && skipDuplicates) continue;
          modules.set(key, { ...row, enabled: true });
          count += 1;
        }
        return { count };
      },
    ),
  },
  $transaction: vi.fn(async (operations: Promise<unknown>[]) => Promise.all(operations)),
};

vi.mock("@/lib/db", () => ({ getPrisma: () => prisma }));

const { ensureDefaultWorkspace } = await import("./repository");

beforeEach(() => {
  workspaces.clear();
  members.clear();
  modules.clear();
  vi.clearAllMocks();
});

describe("ensureDefaultWorkspace", () => {
  it("creates the personal workspace, the owner membership and the given modules once", async () => {
    await ensureDefaultWorkspace("user-1", ["budget", "real-estate"]);

    expect([...workspaces.values()]).toEqual([
      { id: "ws-user-1", name: "Personnel", kind: "PERSONAL" },
    ]);
    expect([...members.values()]).toEqual([
      { id: "wm-user-1", workspaceId: "ws-user-1", userId: "user-1", role: "OWNER" },
    ]);
    expect([...modules.values()]).toEqual([
      { workspaceId: "ws-user-1", moduleKey: "budget", enabled: true },
      { workspaceId: "ws-user-1", moduleKey: "real-estate", enabled: true },
    ]);
  });

  it("creates no duplicate when the seed runs twice", async () => {
    await ensureDefaultWorkspace("user-1", ["budget", "real-estate"]);
    await ensureDefaultWorkspace("user-1", ["budget", "real-estate"]);

    expect(workspaces.size).toBe(1);
    expect(members.size).toBe(1);
    expect(modules.size).toBe(2);
  });

  it("keeps the default module set when no selection is given", async () => {
    await ensureDefaultWorkspace("user-1");

    expect([...modules.values()].map((row) => row.moduleKey)).toEqual([
      "budget",
      "real-estate",
      "development",
    ]);
  });

  it("keeps a disabled module disabled and only adds the missing ones", async () => {
    modules.set(moduleKey("ws-user-1", "budget"), {
      workspaceId: "ws-user-1",
      moduleKey: "budget",
      enabled: false,
    });
    // Enabled outside the initial set: the seed must not hide it either.
    modules.set(moduleKey("ws-user-1", "family"), {
      workspaceId: "ws-user-1",
      moduleKey: "family",
      enabled: true,
    });

    await ensureDefaultWorkspace("user-1", ["budget", "real-estate"]);

    expect(modules.get(moduleKey("ws-user-1", "budget"))?.enabled).toBe(false);
    expect(modules.get(moduleKey("ws-user-1", "real-estate"))?.enabled).toBe(true);
    expect(modules.get(moduleKey("ws-user-1", "family"))?.enabled).toBe(true);
    expect(modules.size).toBe(3);
  });

  it("does not rename a workspace the owner already has", async () => {
    workspaces.set("ws-user-1", { id: "ws-user-1", name: "Personnel renommé", kind: "PERSONAL" });

    await ensureDefaultWorkspace("user-1", ["budget"]);

    expect(workspaces.get("ws-user-1")?.name).toBe("Personnel renommé");
  });
});
