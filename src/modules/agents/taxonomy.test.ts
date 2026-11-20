import { describe, expect, it } from "vitest";
import { AgentClassificationSource, AgentRunOutcome, AgentTaskType } from "@/generated/prisma/enums";
import {
  AGENT_RUN_OUTCOME_LABELS,
  AGENT_RUN_OUTCOMES,
  AGENT_TASK_TYPE_LABELS,
  AGENT_TASK_TYPES,
  CLASSIFICATION_SOURCES,
  countRunsByTaxonomy,
  InvalidTaxonomyError,
  validateOutcome,
  validateTaskType,
} from "./taxonomy";

describe("taxonomy codes", () => {
  it("match the database enums exactly", () => {
    expect([...AGENT_TASK_TYPES]).toEqual(Object.values(AgentTaskType));
    expect([...AGENT_RUN_OUTCOMES]).toEqual(Object.values(AgentRunOutcome));
    expect([...CLASSIFICATION_SOURCES]).toEqual(Object.values(AgentClassificationSource));
  });

  it("have a French label for every code, UNKNOWN included", () => {
    expect(Object.keys(AGENT_TASK_TYPE_LABELS)).toEqual([...AGENT_TASK_TYPES]);
    expect(Object.keys(AGENT_RUN_OUTCOME_LABELS)).toEqual([...AGENT_RUN_OUTCOMES]);
    expect(AGENT_RUN_OUTCOME_LABELS.UNKNOWN).toBe("Inconnu");
  });
});

describe("validation", () => {
  it("accepts every code and UNKNOWN as an explicit value", () => {
    expect(validateTaskType("REVIEW")).toBe("REVIEW");
    expect(validateOutcome("UNKNOWN")).toBe("UNKNOWN");
  });

  it("refuses guesses, other casings and empty values", () => {
    expect(() => validateTaskType("review")).toThrow(InvalidTaxonomyError);
    expect(() => validateOutcome("MERGED")).toThrow(/expected one of/);
    expect(() => validateOutcome("")).toThrow(InvalidTaxonomyError);
    expect(() => validateTaskType(null)).toThrow(InvalidTaxonomyError);
  });
});

describe("countRunsByTaxonomy", () => {
  it("groups by class and keeps unknown runs visible", () => {
    const counts = countRunsByTaxonomy([
      { taskType: "IMPLEMENTATION", outcome: "ACCEPTED" },
      { taskType: "IMPLEMENTATION", outcome: "ACCEPTED" },
      { taskType: "IMPLEMENTATION", outcome: "REJECTED" },
      { taskType: "UNKNOWN", outcome: "UNKNOWN" },
    ]);
    const find = (taskType: string, outcome: string) =>
      counts.find((row) => row.taskType === taskType && row.outcome === outcome)?.runs;

    expect(counts).toHaveLength(AGENT_TASK_TYPES.length * AGENT_RUN_OUTCOMES.length);
    expect(find("IMPLEMENTATION", "ACCEPTED")).toBe(2);
    expect(find("IMPLEMENTATION", "REJECTED")).toBe(1);
    expect(find("UNKNOWN", "UNKNOWN")).toBe(1);
    expect(find("REVIEW", "ACCEPTED")).toBe(0);
    expect(counts.reduce((sum, row) => sum + row.runs, 0)).toBe(4);
  });
});
