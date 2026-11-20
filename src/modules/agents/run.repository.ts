import { getPrisma } from "@/lib/db";
import {
  InvalidAgentRunError,
  MAX_RUNS_PER_INGESTION,
  missingRunFields,
  validateAgentRun,
  type AgentRunInput,
  type AgentRunResult,
  type AgentRunWrite,
  type RunTrackedField,
} from "./run";
import {
  validateOutcome,
  validateTaskType,
  type AgentRunOutcome,
  type AgentTaskType,
  type ClassificationSource,
} from "./taxonomy";

/**
 * Agent run persistence (M13-02), workspace-scoped (M7-04).
 *
 * Ingestion is idempotent on `(workspaceId, externalRef)`: re-sending a run updates
 * it, never duplicates it. Known values only fill or replace; unknown ones never
 * erase. Delivery and cost links only accumulate. A batch is all-or-nothing.
 *
 * Taxonomy (M13-03): codes sent at ingestion are recorded as ADAPTER; a person's
 * classification (`classifyAgentRun`, MANUAL) is never overwritten by re-ingestion.
 *
 * Authorization is the caller's job: reach these functions only after a server-side
 * permission check.
 */

export type AgentRunRecord = {
  readonly id: string;
  readonly externalRef: string;
  readonly agentVersionId: string;
  readonly traceId: string | null;
  readonly startedAt: Date | null;
  readonly endedAt: Date | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly retries: number | null;
  readonly toolCalls: number | null;
  readonly result: AgentRunResult | null;
  readonly initiator: string | null;
  readonly deliveryLinks: readonly string[];
  readonly taskType: AgentTaskType;
  readonly outcome: AgentRunOutcome;
  /** `null` while nobody classified the run. */
  readonly classificationSource: ClassificationSource | null;
  /** Empty means the run's cost is unknown, not zero. */
  readonly costEntryIds: readonly string[];
  readonly missingFields: readonly RunTrackedField[];
  readonly partial: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

type RunRow = Omit<
  AgentRunRecord,
  "costEntryIds" | "missingFields" | "partial" | "result" | "taskType" | "outcome" | "classificationSource"
> & {
  result: string | null;
  taskType: string;
  outcome: string;
  classificationSource: string | null;
  costs: { costEntryId: string }[];
};

const RUN_SELECT = {
  id: true,
  externalRef: true,
  agentVersionId: true,
  traceId: true,
  startedAt: true,
  endedAt: true,
  inputTokens: true,
  outputTokens: true,
  retries: true,
  toolCalls: true,
  result: true,
  initiator: true,
  deliveryLinks: true,
  taskType: true,
  outcome: true,
  classificationSource: true,
  createdAt: true,
  updatedAt: true,
  costs: { select: { costEntryId: true }, orderBy: { costEntryId: "asc" as const } },
} as const;

function toRun({ costs, ...row }: RunRow): AgentRunRecord {
  const missingFields = missingRunFields(row);

  return {
    ...row,
    result: row.result as AgentRunResult | null,
    taskType: row.taskType as AgentTaskType,
    outcome: row.outcome as AgentRunOutcome,
    classificationSource: row.classificationSource as ClassificationSource | null,
    costEntryIds: costs.map((cost) => cost.costEntryId),
    missingFields,
    partial: missingFields.length > 0,
  };
}

/** Taxonomy columns to write, or none when a person already classified the run. */
function adapterClassification(run: AgentRunWrite, existingSource: string | null = null) {
  if (existingSource === "MANUAL" || (run.taskType === undefined && run.outcome === undefined)) return {};
  return { taskType: run.taskType, outcome: run.outcome, classificationSource: "ADAPTER" as const };
}

function knownFields(run: AgentRunWrite) {
  // Prisma skips `undefined`, so unknown values leave the stored ones untouched.
  return {
    traceId: run.traceId,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    inputTokens: run.inputTokens,
    outputTokens: run.outputTokens,
    retries: run.retries,
    toolCalls: run.toolCalls,
    result: run.result,
    initiator: run.initiator,
  };
}

export async function ingestAgentRuns(
  workspaceId: string,
  inputs: readonly AgentRunInput[],
): Promise<{ created: number; updated: number }> {
  if (!Array.isArray(inputs)) throw new InvalidAgentRunError("runs", "expected a list");
  if (inputs.length > MAX_RUNS_PER_INGESTION) {
    throw new InvalidAgentRunError("runs", `at most ${MAX_RUNS_PER_INGESTION} per ingestion`);
  }

  const runs = inputs.map(validateAgentRun);
  if (new Set(runs.map((run) => run.externalRef)).size !== runs.length) {
    throw new InvalidAgentRunError("externalRef", "appears twice in the same batch");
  }

  const versionIds = [...new Set(runs.map((run) => run.agentVersionId))];
  const costIds = [...new Set(runs.flatMap((run) => run.costEntryIds))];

  return getPrisma().$transaction(async (tx) => {
    const versions = await tx.agentVersion.findMany({
      where: { id: { in: versionIds }, agent: { workspaceId } },
      select: { id: true },
    });
    if (versions.length !== versionIds.length) {
      throw new InvalidAgentRunError("agentVersionId", "unknown in this workspace");
    }

    const costs = costIds.length
      ? await tx.costEntry.findMany({ where: { id: { in: costIds }, workspaceId }, select: { id: true } })
      : [];
    if (costs.length !== costIds.length) {
      throw new InvalidAgentRunError("costEntryIds", "unknown in this workspace");
    }

    let created = 0;
    let updated = 0;

    for (const run of runs) {
      const existing = await tx.agentRun.findUnique({
        where: { workspaceId_externalRef: { workspaceId, externalRef: run.externalRef } },
        select: { id: true, agentVersionId: true, deliveryLinks: true, classificationSource: true },
      });

      let runId: string;

      if (existing) {
        if (existing.agentVersionId !== run.agentVersionId) {
          throw new InvalidAgentRunError("agentVersionId", `run ${run.externalRef} already belongs to another version`);
        }

        await tx.agentRun.update({
          where: { id: existing.id },
          data: {
            ...knownFields(run),
            ...adapterClassification(run, existing.classificationSource),
            deliveryLinks: [...new Set([...existing.deliveryLinks, ...run.deliveryLinks])],
          },
        });
        runId = existing.id;
        updated += 1;
      } else {
        const row = await tx.agentRun.create({
          data: {
            ...knownFields(run),
            ...adapterClassification(run),
            workspaceId,
            externalRef: run.externalRef,
            agentVersionId: run.agentVersionId,
            deliveryLinks: [...run.deliveryLinks],
          },
          select: { id: true },
        });
        runId = row.id;
        created += 1;
      }

      if (run.costEntryIds.length) {
        await tx.agentRunCost.createMany({
          data: run.costEntryIds.map((costEntryId) => ({ runId, costEntryId })),
          skipDuplicates: true,
        });
      }
    }

    return { created, updated };
  });
}

/** Newest first. */
export async function listAgentRuns(
  workspaceId: string,
  options: { agentId?: string; limit?: number } = {},
): Promise<AgentRunRecord[]> {
  const rows = (await getPrisma().agentRun.findMany({
    where: { workspaceId, ...(options.agentId ? { agentVersion: { agentId: options.agentId } } : {}) },
    orderBy: [{ startedAt: { sort: "desc", nulls: "last" } }, { id: "asc" }],
    take: Math.min(Math.max(options.limit ?? 200, 1), 1000),
    select: RUN_SELECT,
  })) as RunRow[];

  return rows.map(toRun);
}

/** The other direction of the cost link: runs a cost entry is attributed to. */
export async function listRunsForCostEntry(workspaceId: string, costEntryId: string): Promise<AgentRunRecord[]> {
  const rows = (await getPrisma().agentRun.findMany({
    where: { workspaceId, costs: { some: { costEntryId } } },
    orderBy: [{ startedAt: { sort: "desc", nulls: "last" } }, { id: "asc" }],
    select: RUN_SELECT,
  })) as RunRow[];

  return rows.map(toRun);
}

/**
 * A person classifies a run (MANUAL). Absent fields keep their value; `UNKNOWN` is
 * allowed. Returns `false` when the run is not in this workspace.
 */
export async function classifyAgentRun(
  workspaceId: string,
  runId: string,
  input: { taskType?: unknown; outcome?: unknown },
): Promise<boolean> {
  const taskType = input.taskType === undefined ? undefined : validateTaskType(input.taskType);
  const outcome = input.outcome === undefined ? undefined : validateOutcome(input.outcome);
  if (taskType === undefined && outcome === undefined) {
    throw new InvalidAgentRunError("classification", "expected a task type or an outcome");
  }

  const { count } = await getPrisma().agentRun.updateMany({
    where: { id: runId, workspaceId },
    data: { taskType, outcome, classificationSource: "MANUAL" },
  });

  return count === 1;
}
