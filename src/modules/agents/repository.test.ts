import { beforeEach, describe, expect, it, vi } from "vitest";
import { InvalidAgentConfigError, type AgentConfigInput } from "./config";

type Row = Record<string, unknown>;

let agents: Row[] = [];
let versions: Row[] = [];
let members: Row[] = [];
let sequence = 0;
const NOW = new Date("2026-03-15T12:00:00.000Z");

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, value]) => row[key] === value);
}

function withVersions(agent: Row, all = false): Row {
  const own = versions
    .filter((version) => version.agentId === agent.id)
    .sort((left, right) => (right.version as number) - (left.version as number));
  return { ...agent, versions: all ? own : own.slice(0, 1) };
}

const prisma = {
  agent: {
    create: vi.fn(async ({ data }: { data: Row }) => {
      if (agents.some((agent) => agent.workspaceId === data.workspaceId && agent.name === data.name)) {
        throw Object.assign(new Error("unique"), { code: "P2002" });
      }
      const { versions: nested, ...rest } = data as Row & { versions: { create: Row } };
      const agent = { ...rest, id: `agent-${++sequence}`, status: "ACTIVE", createdAt: NOW, updatedAt: NOW };
      agents.push(agent);
      versions.push({ ...nested.create, id: `version-${++sequence}`, agentId: agent.id, createdAt: NOW });
      return withVersions(agent);
    }),
    findFirst: vi.fn(async ({ where, select }: { where: Row; select: Row }) => {
      const agent = agents.find((row) => matches(row, where));
      if (!agent) return null;
      const history = (select.versions as { take?: number } | undefined)?.take === undefined;
      return withVersions(agent, history);
    }),
    findMany: vi.fn(async ({ where }: { where: Row }) => agents.filter((row) => matches(row, where)).map((row) => withVersions(row))),
    updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const hits = agents.filter((row) => matches(row, where));
      hits.forEach((row) => Object.assign(row, data));
      return { count: hits.length };
    }),
  },
  agentVersion: {
    create: vi.fn(async ({ data }: { data: Row }) => {
      const row = { ...data, id: `version-${++sequence}`, createdAt: NOW };
      versions.push(row);
      return row;
    }),
  },
  workspaceMember: {
    findFirst: vi.fn(async ({ where }: { where: Row }) => members.find((row) => matches(row, where)) ?? null),
  },
  $queryRaw: vi.fn(async () => []),
  $transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback(prisma)),
};

vi.mock("@/lib/db", () => ({ getPrisma: () => prisma }));

const { AgentNotFoundError, createAgent, findAgent, listAgentVersions, listAgents, updateAgentConfig, updateAgentDetails } =
  await import("./repository");

const config: AgentConfigInput = {
  modelPolicy: { primary: { provider: "anthropic", model: "claude-sonnet-5-5" } },
  tools: ["git"],
  ownerId: "user-1",
  repositoryScopes: ["org/api"],
};

beforeEach(() => {
  agents = [];
  versions = [];
  members = [
    { workspaceId: "ws-1", userId: "user-1", id: "m-1" },
    { workspaceId: "ws-1", userId: "user-2", id: "m-2" },
    { workspaceId: "ws-2", userId: "user-3", id: "m-3" },
  ];
  sequence = 0;
  vi.clearAllMocks();
});

describe("createAgent", () => {
  it("creates version 1 with its fingerprint", async () => {
    const agent = await createAgent("ws-1", { name: "Revue de PR", config });

    expect(agent).toMatchObject({ name: "Revue de PR", status: "ACTIVE", latestVersion: { version: 1 } });
    expect(agent.latestVersion.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(agent.latestVersion.config.tools).toEqual(["git"]);
  });

  it("refuses an owner outside the workspace and a duplicate name", async () => {
    await expect(createAgent("ws-1", { name: "A", config: { ...config, ownerId: "user-3" } })).rejects.toThrow(/member/);
    await createAgent("ws-1", { name: "A", config });
    await expect(createAgent("ws-1", { name: "A", config })).rejects.toThrow(/already used/);
  });
});

describe("updateAgentConfig", () => {
  it("creates a new version when the configuration changes and keeps the old one intact", async () => {
    const agent = await createAgent("ws-1", { name: "A", config });
    const first = { ...versions[0] };

    const { agent: updated, created } = await updateAgentConfig("ws-1", agent.id, { ...config, tools: ["git", "bash"] });

    expect(created).toBe(true);
    expect(updated.latestVersion.version).toBe(2);
    expect(updated.latestVersion.fingerprint).not.toBe(agent.latestVersion.fingerprint);
    expect(versions[0]).toEqual(first);
    expect(prisma.agentVersion.create).toHaveBeenCalledTimes(1);
  });

  it("creates nothing when only the order or duplicates change", async () => {
    const agent = await createAgent("ws-1", { name: "A", config: { ...config, tools: ["git", "bash"] } });

    const { created, agent: same } = await updateAgentConfig("ws-1", agent.id, { ...config, tools: ["bash", "git", "git"] });

    expect(created).toBe(false);
    expect(same.latestVersion.version).toBe(1);
    expect(prisma.agentVersion.create).not.toHaveBeenCalled();
  });

  it("does not reach another workspace's agent", async () => {
    const agent = await createAgent("ws-1", { name: "A", config });
    await expect(updateAgentConfig("ws-2", agent.id, { ...config, ownerId: "user-3" })).rejects.toBeInstanceOf(AgentNotFoundError);
    expect(await findAgent("ws-2", agent.id)).toBeNull();
    expect(await listAgentVersions("ws-2", agent.id)).toBeNull();
  });

  it("refuses a new owner who is not a member", async () => {
    const agent = await createAgent("ws-1", { name: "A", config });
    await expect(updateAgentConfig("ws-1", agent.id, { ...config, ownerId: "user-3" })).rejects.toBeInstanceOf(InvalidAgentConfigError);
    expect(versions).toHaveLength(1);
  });
});

describe("history and details", () => {
  it("lists every version newest first", async () => {
    const agent = await createAgent("ws-1", { name: "A", config });
    await updateAgentConfig("ws-1", agent.id, { ...config, ownerId: "user-2" });
    await updateAgentConfig("ws-1", agent.id, { ...config, repositoryScopes: [] });

    const history = await listAgentVersions("ws-1", agent.id);
    expect(history?.map((version) => version.version)).toEqual([3, 2, 1]);
    expect(history?.[1].config.ownerId).toBe("user-2");
  });

  it("renaming or pausing creates no version", async () => {
    const agent = await createAgent("ws-1", { name: "A", config });

    expect(await updateAgentDetails("ws-1", agent.id, { name: "B", status: "PAUSED" })).toBe(true);
    expect(await updateAgentDetails("ws-2", agent.id, { status: "RETIRED" })).toBe(false);
    expect(versions).toHaveLength(1);
    expect((await listAgents("ws-1"))[0]).toMatchObject({ name: "B", status: "PAUSED" });
    await expect(updateAgentDetails("ws-1", agent.id, { status: "DELETED" })).rejects.toThrow(/unknown/);
  });
});
