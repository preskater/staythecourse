import { describe, expect, it } from "vitest";
import { InvalidAgentRunError, missingRunFields, validateAgentRun } from "./run";

const base = { externalRef: "run-1", agentVersionId: "version-1" };

describe("validateAgentRun", () => {
  it("keeps absent and null fields unknown, never zero", () => {
    const run = validateAgentRun({ ...base, inputTokens: null, retries: 0 });

    expect(run.inputTokens).toBeUndefined();
    expect(run.outputTokens).toBeUndefined();
    expect(run.retries).toBe(0);
    expect(run.deliveryLinks).toEqual([]);
    expect(run.costEntryIds).toEqual([]);
  });

  it("normalises a full report", () => {
    const run = validateAgentRun({
      ...base,
      traceId: " trace-abc ",
      startedAt: "2026-11-20T10:00:00+01:00",
      endedAt: "2026-11-20T09:05:00Z",
      result: "SUCCEEDED",
      deliveryLinks: ["https://github.com/org/api/pull/12", "https://github.com/org/api/pull/12"],
      costEntryIds: ["cost-1", "cost-1"],
    });

    expect(run.traceId).toBe("trace-abc");
    expect(run.startedAt?.toISOString()).toBe("2026-11-20T09:00:00.000Z");
    expect(run.deliveryLinks).toEqual(["https://github.com/org/api/pull/12"]);
    expect(run.costEntryIds).toEqual(["cost-1"]);
  });

  it("refuses content fields outside the metadata contract", () => {
    expect(() => validateAgentRun({ ...base, prompt: "Hello" })).toThrow(/not part of the run metadata/);
    expect(() => validateAgentRun({ ...base, completion: "World" })).toThrow(InvalidAgentRunError);
  });

  it("refuses credentials in references and links", () => {
    expect(() => validateAgentRun({ ...base, traceId: "sk-ant-api03-abcdefghijklmnopqrstuvwxyz" })).toThrow(/credential/);
    expect(() => validateAgentRun({ ...base, deliveryLinks: ["https://user:pass@gitlab.example.test/x"] })).toThrow(
      /credentials/,
    );
    expect(() => validateAgentRun({ ...base, deliveryLinks: ["javascript:alert(1)"] })).toThrow(/http/);
  });

  it("refuses bad counts, dates and results", () => {
    expect(() => validateAgentRun({ ...base, toolCalls: -1 })).toThrow(/non-negative/);
    expect(() => validateAgentRun({ ...base, inputTokens: 1.5 })).toThrow(/non-negative/);
    expect(() => validateAgentRun({ ...base, startedAt: "2026-11-20" })).toThrow(/time zone/);
    expect(() =>
      validateAgentRun({ ...base, startedAt: "2026-11-20T10:00:00Z", endedAt: "2026-11-20T09:00:00Z" }),
    ).toThrow(/before/);
    expect(() => validateAgentRun({ ...base, result: "PARTIAL" })).toThrow(/unknown result/);
    expect(() => validateAgentRun({ agentVersionId: "version-1" })).toThrow(/externalRef/);
  });
});

describe("missingRunFields", () => {
  it("lists unknown tracked fields; zero counts as known", () => {
    expect(
      missingRunFields({
        traceId: "t",
        startedAt: new Date(),
        endedAt: null,
        inputTokens: 0,
        outputTokens: 0,
        retries: 0,
        toolCalls: 0,
        result: "FAILED",
        initiator: undefined,
      }),
    ).toEqual(["endedAt", "initiator"]);
  });
});
