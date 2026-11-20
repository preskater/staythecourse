import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

let runs: Row[] = [];
let links: Row[] = [];
let sequence = 0;
const NOW = new Date("2026-11-20T12:00:00.000Z");

const versions = [
  { id: "version-1", agentId: "agent-1", workspaceId: "ws-1" },
  { id: "version-2", agentId: "agent-1", workspaceId: "ws-1" },
  { id: "version-foreign", agentId: "agent-9", workspaceId: "ws-2" },
];
const costEntries = [
  { id: "cost-1", workspaceId: "ws-1" },
  { id: "cost-2", workspaceId: "ws-1" },
  { id: "cost-foreign", workspaceId: "ws-2" },
];

function withCosts(run: Row): Row {
  return { ...run, costs: links.filter((link) => link.runId === run.id).map(({ costEntryId }) => ({ costEntryId })) };
}

const prisma = {
  agentVersion: {
    findMany: vi.fn(async ({ where }: { where: { id: { in: string[] }; agent: { workspaceId: string } } }) =>
      versions.filter((row) => where.id.in.includes(row.id) && row.workspaceId === where.agent.workspaceId),
    ),
  },
  costEntry: {
    findMany: vi.fn(async ({ where }: { where: { id: { in: string[] }; workspaceId: string } }) =>
      costEntries.filter((row) => where.id.in.includes(row.id) && row.workspaceId === where.workspaceId),
    ),
  },
  agentRun: {
    findUnique: vi.fn(
      async ({ where }: { where: { workspaceId_externalRef: { workspaceId: string; externalRef: string } } }) => {
        const key = where.workspaceId_externalRef;
        return runs.find((row) => row.workspaceId === key.workspaceId && row.externalRef === key.externalRef) ?? null;
      },
    ),
    create: vi.fn(async ({ data }: { data: Row }) => {
      const row = {
        traceId: null,
        startedAt: null,
        endedAt: null,
        inputTokens: null,
        outputTokens: null,
        retries: null,
        toolCalls: null,
        result: null,
        initiator: null,
        taskType: "UNKNOWN",
        outcome: "UNKNOWN",
        classificationSource: null,
        // Like Prisma: `undefined` falls back to the column default.
        ...Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined)),
        id: `run-${++sequence}`,
        createdAt: NOW,
        updatedAt: NOW,
      };
      runs.push(row);
      return row;
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Row }) => {
      const row = runs.find((run) => run.id === where.id)!;
      // Like Prisma: `undefined` leaves the column untouched.
      Object.entries(data).forEach(([key, value]) => value !== undefined && (row[key] = value));
      return row;
    }),
    updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const hits = runs.filter((row) => row.id === where.id && row.workspaceId === where.workspaceId);
      hits.forEach((row) => Object.entries(data).forEach(([key, value]) => value !== undefined && (row[key] = value)));
      return { count: hits.length };
    }),
    findMany: vi.fn(async ({ where }: { where: Row & { costs?: { some: { costEntryId: string } } } }) =>
      runs
        .filter((row) => row.workspaceId === where.workspaceId)
        .filter(
          (row) =>
            !where.costs ||
            links.some((link) => link.runId === row.id && link.costEntryId === where.costs!.some.costEntryId),
        )
        .map(withCosts),
    ),
  },
  agentRunCost: {
    createMany: vi.fn(async ({ data }: { data: Row[] }) => {
      const fresh = data.filter(
        (item) => !links.some((link) => link.runId === item.runId && link.costEntryId === item.costEntryId),
      );
      links.push(...fresh);
      return { count: fresh.length };
    }),
  },
  $transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback(prisma)),
};

vi.mock("@/lib/db", () => ({ getPrisma: () => prisma }));

const { classifyAgentRun, ingestAgentRuns, listAgentRuns, listRunsForCostEntry } = await import("./run.repository");

const full = {
  externalRef: "run-a",
  agentVersionId: "version-1",
  traceId: "trace-a",
  startedAt: "2026-11-20T09:00:00Z",
  endedAt: "2026-11-20T09:05:00Z",
  inputTokens: 1200,
  outputTokens: 300,
  retries: 0,
  toolCalls: 4,
  result: "SUCCEEDED",
  initiator: "ci",
  deliveryLinks: ["https://github.com/org/api/pull/12"],
  costEntryIds: ["cost-1"],
};

beforeEach(() => {
  runs = [];
  links = [];
  sequence = 0;
  vi.clearAllMocks();
});

describe("ingestAgentRuns", () => {
  it("re-ingesting the same runs creates no duplicates", async () => {
    expect(await ingestAgentRuns("ws-1", [full])).toEqual({ created: 1, updated: 0 });
    expect(await ingestAgentRuns("ws-1", [full])).toEqual({ created: 0, updated: 1 });

    expect(runs).toHaveLength(1);
    expect(links).toHaveLength(1);
    expect(runs[0].deliveryLinks).toEqual(["https://github.com/org/api/pull/12"]);
  });

  it("the same external reference in another workspace is another run", async () => {
    await ingestAgentRuns("ws-1", [full]);
    await ingestAgentRuns("ws-2", [{ externalRef: "run-a", agentVersionId: "version-foreign" }]);

    expect(runs).toHaveLength(2);
  });

  it("keeps a partial run visible as partial, with an unknown cost", async () => {
    await ingestAgentRuns("ws-1", [{ externalRef: "run-b", agentVersionId: "version-1", startedAt: "2026-11-20T09:00:00Z" }]);

    const [run] = await listAgentRuns("ws-1");
    expect(run.partial).toBe(true);
    expect(run.inputTokens).toBeNull();
    expect(run.missingFields).toContain("endedAt");
    expect(run.costEntryIds).toEqual([]);
  });

  it("completes a partial run later without erasing known values", async () => {
    await ingestAgentRuns("ws-1", [{ externalRef: "run-a", agentVersionId: "version-1", traceId: "trace-a", retries: 2 }]);
    await ingestAgentRuns("ws-1", [{ ...full, traceId: undefined, retries: undefined, costEntryIds: ["cost-2"] }]);
    await ingestAgentRuns("ws-1", [{ externalRef: "run-a", agentVersionId: "version-1", inputTokens: null }]);

    const [run] = await listAgentRuns("ws-1");
    expect(run).toMatchObject({ traceId: "trace-a", retries: 2, inputTokens: 1200, partial: false });
    expect(run.costEntryIds).toEqual(["cost-2"]);
  });

  it("traces cost links both ways", async () => {
    await ingestAgentRuns("ws-1", [full, { ...full, externalRef: "run-c", costEntryIds: ["cost-1", "cost-2"] }]);

    expect((await listRunsForCostEntry("ws-1", "cost-1")).map((run) => run.externalRef)).toEqual(["run-a", "run-c"]);
    expect((await listRunsForCostEntry("ws-1", "cost-2")).map((run) => run.externalRef)).toEqual(["run-c"]);
    expect(await listRunsForCostEntry("ws-2", "cost-1")).toEqual([]);
  });

  it("refuses another workspace's version or cost entry and writes nothing", async () => {
    await expect(ingestAgentRuns("ws-1", [{ ...full, agentVersionId: "version-foreign" }])).rejects.toThrow(
      /unknown in this workspace/,
    );
    await expect(ingestAgentRuns("ws-1", [{ ...full, costEntryIds: ["cost-foreign"] }])).rejects.toThrow(
      /unknown in this workspace/,
    );
    expect(runs).toEqual([]);
  });

  it("refuses moving a run to another version and duplicates inside a batch", async () => {
    await ingestAgentRuns("ws-1", [full]);

    await expect(ingestAgentRuns("ws-1", [{ ...full, agentVersionId: "version-2" }])).rejects.toThrow(/another version/);
    await expect(ingestAgentRuns("ws-1", [full, full])).rejects.toThrow(/twice/);
    expect(runs[0].agentVersionId).toBe("version-1");
  });

  it("validates the whole batch before writing", async () => {
    await expect(ingestAgentRuns("ws-1", [full, { ...full, externalRef: "run-x", prompt: "secret plan" }])).rejects.toThrow(
      /metadata contract/,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe("taxonomy (M13-03)", () => {
  it("leaves an unclassified run explicitly UNKNOWN, with no source", async () => {
    await ingestAgentRuns("ws-1", [full]);

    const [run] = await listAgentRuns("ws-1");
    expect(run).toMatchObject({ taskType: "UNKNOWN", outcome: "UNKNOWN", classificationSource: null });
  });

  it("records codes sent at ingestion as set by the adapter", async () => {
    await ingestAgentRuns("ws-1", [{ ...full, taskType: "REVIEW" }]);
    await ingestAgentRuns("ws-1", [{ ...full, outcome: "ACCEPTED" }]);

    const [run] = await listAgentRuns("ws-1");
    expect(run).toMatchObject({ taskType: "REVIEW", outcome: "ACCEPTED", classificationSource: "ADAPTER" });
  });

  it("never lets re-ingestion overwrite a person's classification", async () => {
    await ingestAgentRuns("ws-1", [{ ...full, taskType: "REVIEW", outcome: "ACCEPTED" }]);
    const [{ id }] = await listAgentRuns("ws-1");

    expect(await classifyAgentRun("ws-1", id, { outcome: "REJECTED" })).toBe(true);
    await ingestAgentRuns("ws-1", [{ ...full, taskType: "TEST", outcome: "ACCEPTED" }]);

    const [run] = await listAgentRuns("ws-1");
    expect(run).toMatchObject({ taskType: "REVIEW", outcome: "REJECTED", classificationSource: "MANUAL" });
  });

  it("refuses unknown codes and another workspace's run", async () => {
    await expect(ingestAgentRuns("ws-1", [{ ...full, outcome: "MERGED" }])).rejects.toThrow(/expected one of/);
    await ingestAgentRuns("ws-1", [full]);
    const [{ id }] = await listAgentRuns("ws-1");

    expect(await classifyAgentRun("ws-2", id, { outcome: "ACCEPTED" })).toBe(false);
    await expect(classifyAgentRun("ws-1", id, {})).rejects.toThrow(/task type or an outcome/);
    expect((await listAgentRuns("ws-1"))[0].outcome).toBe("UNKNOWN");
  });
});
