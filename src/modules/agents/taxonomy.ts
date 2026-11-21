/**
 * Agent task and outcome taxonomy (M13-03). Pure, no I/O.
 *
 * The single source of the codes: every metric (M13-05) groups by these values,
 * and the Prisma enums must list exactly the same codes (checked by a test).
 *
 * Task type: what the run was asked to do.
 * - IMPLEMENTATION: writing or changing production code.
 * - TEST: writing or fixing tests.
 * - REVIEW: reviewing someone else's change.
 * - DOCUMENTATION: writing or updating documentation.
 * - DEBUGGING: investigating and fixing a defect.
 * - ANALYSIS: research, estimation or answering a question, no change delivered.
 * - UNKNOWN: not classified.
 *
 * Outcome: what became of the work, judged after the run. It is not the run's
 * technical `result` (SUCCEEDED/FAILED/CANCELLED): a run can succeed technically
 * and still see its work rejected.
 * - ACCEPTED: the work was kept as delivered.
 * - PARTIAL: part of the work was kept, the rest reworked or dropped.
 * - REJECTED: the work was refused.
 * - FAILED: the run produced no usable work.
 * - CANCELLED: the run was stopped before it delivered.
 * - SUPERSEDED: the work was replaced by another run or change.
 * - UNKNOWN: not classified.
 *
 * UNKNOWN is an explicit, allowed value and the default: nothing is ever guessed.
 * Values are set by an adapter at ingestion or by a person; `source` records which.
 * A person's classification wins: re-ingestion never overwrites it.
 */

export const AGENT_TASK_TYPES = [
  "IMPLEMENTATION",
  "TEST",
  "REVIEW",
  "DOCUMENTATION",
  "DEBUGGING",
  "ANALYSIS",
  "UNKNOWN",
] as const;
export type AgentTaskType = (typeof AGENT_TASK_TYPES)[number];

export const AGENT_RUN_OUTCOMES = [
  "ACCEPTED",
  "PARTIAL",
  "REJECTED",
  "FAILED",
  "CANCELLED",
  "SUPERSEDED",
  "UNKNOWN",
] as const;
export type AgentRunOutcome = (typeof AGENT_RUN_OUTCOMES)[number];

export const CLASSIFICATION_SOURCES = ["ADAPTER", "MANUAL"] as const;
export type ClassificationSource = (typeof CLASSIFICATION_SOURCES)[number];

export const AGENT_TASK_TYPE_LABELS: Record<AgentTaskType, string> = {
  IMPLEMENTATION: "Implémentation",
  TEST: "Tests",
  REVIEW: "Revue",
  DOCUMENTATION: "Documentation",
  DEBUGGING: "Débogage",
  ANALYSIS: "Analyse",
  UNKNOWN: "Inconnu",
};

export const AGENT_RUN_OUTCOME_LABELS: Record<AgentRunOutcome, string> = {
  ACCEPTED: "Accepté",
  PARTIAL: "Partiel",
  REJECTED: "Rejeté",
  FAILED: "Échoué",
  CANCELLED: "Annulé",
  SUPERSEDED: "Remplacé",
  UNKNOWN: "Inconnu",
};

export class InvalidTaxonomyError extends Error {
  constructor(
    readonly field: string,
    reason: string,
  ) {
    super(`Invalid agent run ${field}: ${reason}`);
    this.name = "InvalidTaxonomyError";
  }
}

function code<T extends string>(values: readonly T[], value: unknown, field: string): T {
  if (typeof value !== "string" || !(values as readonly string[]).includes(value)) {
    throw new InvalidTaxonomyError(field, `expected one of ${values.join(", ")}`);
  }

  return value as T;
}

export const validateTaskType = (value: unknown): AgentTaskType => code(AGENT_TASK_TYPES, value, "taskType");
export const validateOutcome = (value: unknown): AgentRunOutcome => code(AGENT_RUN_OUTCOMES, value, "outcome");

export type TaxonomyCount = { taskType: AgentTaskType; outcome: AgentRunOutcome; runs: number };

/**
 * Counts runs per (task type, outcome), in taxonomy order. Every combination is
 * listed, zero included, so UNKNOWN stays visible next to the classified classes.
 */
export function countRunsByTaxonomy(
  runs: readonly { taskType: AgentTaskType; outcome: AgentRunOutcome }[],
): TaxonomyCount[] {
  const counts = new Map<string, number>();
  for (const run of runs) {
    const key = `${run.taskType}/${run.outcome}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return AGENT_TASK_TYPES.flatMap((taskType) =>
    AGENT_RUN_OUTCOMES.map((outcome) => ({ taskType, outcome, runs: counts.get(`${taskType}/${outcome}`) ?? 0 })),
  );
}
