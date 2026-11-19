import type { Prisma } from "@/generated/prisma/client";
import { isUniqueConstraintError } from "@/lib/actions";
import { getPrisma } from "@/lib/db";
import {
  agentConfigFingerprint,
  InvalidAgentConfigError,
  validateAgentConfig,
  validateAgentName,
  validateAgentStatus,
  type AgentConfig,
  type AgentConfigInput,
  type AgentStatus,
  type ModelPolicy,
} from "./config";

/**
 * Agent persistence (M13-01), workspace-scoped (M7-04).
 *
 * Versions are insert-only: nothing in `src/` updates or deletes an `AgentVersion`,
 * so a run (M13-02) that points at a version keeps pointing at the configuration
 * that produced it. Saving a configuration whose fingerprint equals the latest
 * version's creates nothing.
 *
 * Authorization is the caller's job: these functions must only be reached after a
 * server-side permission check, like every repository in this project.
 */

export class AgentNotFoundError extends Error {
  constructor() {
    super("Agent not found in this workspace.");
    this.name = "AgentNotFoundError";
  }
}

export type AgentVersionRecord = {
  readonly id: string;
  readonly version: number;
  readonly config: AgentConfig;
  readonly fingerprint: string;
  readonly createdAt: Date;
};

export type AgentRecord = {
  readonly id: string;
  readonly name: string;
  readonly status: AgentStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly latestVersion: AgentVersionRecord;
};

type VersionRow = {
  id: string;
  version: number;
  modelPolicy: unknown;
  tools: string[];
  ownerId: string;
  repositoryScopes: string[];
  fingerprint: string;
  createdAt: Date;
};

type AgentRow = {
  id: string;
  name: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  versions: VersionRow[];
};

const VERSION_SELECT = {
  id: true,
  version: true,
  modelPolicy: true,
  tools: true,
  ownerId: true,
  repositoryScopes: true,
  fingerprint: true,
  createdAt: true,
} as const;

const AGENT_SELECT = {
  id: true,
  name: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  versions: { orderBy: { version: "desc" as const }, take: 1, select: VERSION_SELECT },
} as const;

function toVersion(row: VersionRow): AgentVersionRecord {
  return {
    id: row.id,
    version: row.version,
    // Re-validated on read: a malformed stored row fails loudly.
    config: validateAgentConfig({
      modelPolicy: row.modelPolicy as AgentConfigInput["modelPolicy"],
      tools: row.tools,
      ownerId: row.ownerId,
      repositoryScopes: row.repositoryScopes,
    }),
    fingerprint: row.fingerprint,
    createdAt: row.createdAt,
  };
}

function toAgent(row: AgentRow): AgentRecord {
  const latest = row.versions[0];

  if (!latest) {
    throw new Error("Stored agent has no version.");
  }

  return {
    id: row.id,
    name: row.name,
    status: validateAgentStatus(row.status),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    latestVersion: toVersion(latest),
  };
}

function versionData(config: AgentConfig) {
  return {
    modelPolicy: JSON.parse(JSON.stringify(config.modelPolicy as ModelPolicy)) as Prisma.InputJsonValue,
    tools: [...config.tools],
    ownerId: config.ownerId,
    repositoryScopes: [...config.repositoryScopes],
    fingerprint: agentConfigFingerprint(config),
  };
}

async function assertMember(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  userId: string,
): Promise<void> {
  const member = await tx.workspaceMember.findFirst({
    where: { workspaceId, userId },
    select: { id: true },
  });

  if (!member) {
    throw new InvalidAgentConfigError("ownerId", "the owner must be a member of this workspace");
  }
}

export async function listAgents(workspaceId: string): Promise<AgentRecord[]> {
  const rows = (await getPrisma().agent.findMany({
    where: { workspaceId },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    select: AGENT_SELECT,
  })) as AgentRow[];

  return rows.map(toAgent);
}

export async function findAgent(workspaceId: string, agentId: string): Promise<AgentRecord | null> {
  const row = (await getPrisma().agent.findFirst({
    where: { id: agentId, workspaceId },
    select: AGENT_SELECT,
  })) as AgentRow | null;

  return row ? toAgent(row) : null;
}

/** Full history, newest first; `null` when the agent is not in this workspace. */
export async function listAgentVersions(
  workspaceId: string,
  agentId: string,
): Promise<AgentVersionRecord[] | null> {
  const row = (await getPrisma().agent.findFirst({
    where: { id: agentId, workspaceId },
    select: { versions: { orderBy: { version: "desc" }, select: VERSION_SELECT } },
  })) as { versions: VersionRow[] } | null;

  return row ? row.versions.map(toVersion) : null;
}

/** Creates an agent with its version 1. A name is unique per workspace. */
export async function createAgent(
  workspaceId: string,
  input: { name: unknown; config: AgentConfigInput },
): Promise<AgentRecord> {
  const name = validateAgentName(input.name);
  const config = validateAgentConfig(input.config);

  try {
    return await getPrisma().$transaction(async (tx) => {
      await assertMember(tx, workspaceId, config.ownerId);

      const row = (await tx.agent.create({
        data: { workspaceId, name, versions: { create: { version: 1, ...versionData(config) } } },
        select: AGENT_SELECT,
      })) as AgentRow;

      return toAgent(row);
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new InvalidAgentConfigError("name", "already used in this workspace");
    }

    throw error;
  }
}

/**
 * Saves a configuration. A new version is created only when the fingerprint differs
 * from the latest one; `created` says which happened.
 */
export async function updateAgentConfig(
  workspaceId: string,
  agentId: string,
  input: AgentConfigInput,
): Promise<{ agent: AgentRecord; created: boolean }> {
  const config = validateAgentConfig(input);
  const fingerprint = agentConfigFingerprint(config);

  return getPrisma().$transaction(async (tx) => {
    const found = await tx.agent.findFirst({ where: { id: agentId, workspaceId }, select: { id: true } });

    if (!found) {
      throw new AgentNotFoundError();
    }

    // Serialises concurrent saves so two of them cannot claim the same version number.
    await tx.$queryRaw`SELECT "id" FROM "Agent" WHERE "id" = ${agentId} AND "workspaceId" = ${workspaceId} FOR UPDATE`;
    await assertMember(tx, workspaceId, config.ownerId);

    const current = (await tx.agent.findFirst({
      where: { id: agentId, workspaceId },
      select: AGENT_SELECT,
    })) as AgentRow | null;

    if (!current) {
      throw new AgentNotFoundError();
    }

    const latest = current.versions[0];

    if (latest && latest.fingerprint === fingerprint) {
      return { agent: toAgent(current), created: false };
    }

    await tx.agentVersion.create({
      data: { agentId, version: (latest?.version ?? 0) + 1, ...versionData(config) },
    });

    const updated = (await tx.agent.findFirst({
      where: { id: agentId, workspaceId },
      select: AGENT_SELECT,
    })) as AgentRow;

    return { agent: toAgent(updated), created: true };
  });
}

/** Renames an agent or changes its status; no version is created. `false` means not found. */
export async function updateAgentDetails(
  workspaceId: string,
  agentId: string,
  input: { name?: unknown; status?: unknown },
): Promise<boolean> {
  const data: { name?: string; status?: AgentStatus } = {};

  if (input.name !== undefined) data.name = validateAgentName(input.name);
  if (input.status !== undefined) data.status = validateAgentStatus(input.status);

  try {
    const { count } = await getPrisma().agent.updateMany({ where: { id: agentId, workspaceId }, data });
    return count === 1;
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new InvalidAgentConfigError("name", "already used in this workspace");
    }

    throw error;
  }
}
