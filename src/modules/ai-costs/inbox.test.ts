import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { InvalidAllocationMathError } from "./allocation";
import {
  allocationFailureReason,
  applyPolicySubmissionSchema,
  describeDimensions,
  finalizeSubmissionSchema,
  inboxEntryLabel,
  inboxEntryState,
  inboxView,
  INBOX_BULK_LIMIT,
} from "./inbox";
import { FinalizedCostEntryError } from "./ledger";
import { InvalidAllocationPolicyError } from "./policy";

const money = (value: string) => ({ amount: new Decimal(value) });

describe("inboxView", () => {
  it("never shows a read failure as an empty inbox", () => {
    expect(inboxView({ ok: false })).toEqual({ kind: "error" });
  });

  it("tells an empty ledger from an inbox with nothing left to review", () => {
    expect(inboxView({ ok: true, entryCount: 0, costCount: 0 })).toEqual({ kind: "no-costs" });
    expect(inboxView({ ok: true, entryCount: 0, costCount: 4 })).toEqual({ kind: "nothing-to-review" });
    expect(inboxView({ ok: true, entryCount: 2, costCount: 4 })).toEqual({ kind: "list" });
  });
});

describe("inboxEntryState", () => {
  it("follows the conservation split, credits included", () => {
    expect(inboxEntryState({ allocated: money("0"), unallocated: money("100") })).toBe("UNALLOCATED");
    expect(inboxEntryState({ allocated: money("40"), unallocated: money("60") })).toBe("PARTIAL");
    expect(inboxEntryState({ allocated: money("-20"), unallocated: money("0") })).toBe("ALLOCATED");
  });
});

describe("allocationFailureReason", () => {
  it("names the reason in French", () => {
    expect(allocationFailureReason(new FinalizedCostEntryError())).toMatch(/déjà validé/);
    expect(allocationFailureReason(new InvalidAllocationPolicyError("amount", "nothing left to allocate"))).toMatch(
      /déjà entièrement réparti/,
    );
    expect(
      allocationFailureReason(new InvalidAllocationPolicyError("measures", "no target has any weight: nothing can be split")),
    ).toMatch(/Aucune cible/);
    expect(allocationFailureReason(new InvalidAllocationMathError("too much"))).toMatch(/dépasserait/);
    expect(allocationFailureReason(new Error("db"))).toBe("Répartition impossible pour ce coût.");
  });
});

describe("bulk contracts", () => {
  const ids = (count: number) => Array.from({ length: count }, (_, index) => `entry-${index}`);

  it("bounds bulk actions and refuses duplicates", () => {
    expect(finalizeSubmissionSchema.safeParse({ entryIds: ids(INBOX_BULK_LIMIT) }).success).toBe(true);
    expect(finalizeSubmissionSchema.safeParse({ entryIds: ids(INBOX_BULK_LIMIT + 1) }).success).toBe(false);
    expect(finalizeSubmissionSchema.safeParse({ entryIds: [] }).success).toBe(false);
    expect(finalizeSubmissionSchema.safeParse({ entryIds: ["a", "a"] }).success).toBe(false);
  });

  it("accepts per-target values for a single entry only", () => {
    const base = { policyId: "policy-1", dryRun: true };
    expect(applyPolicySubmissionSchema.safeParse({ ...base, entryIds: ["a"], measures: ["2", "1"] }).success).toBe(true);
    expect(applyPolicySubmissionSchema.safeParse({ ...base, entryIds: ["a", "b"], measures: ["2", "1"] }).success).toBe(false);
    expect(applyPolicySubmissionSchema.safeParse({ ...base, entryIds: ["a", "b"], measures: null }).success).toBe(true);
  });
});

describe("labels", () => {
  it("reads the import label and describes dimensions with project names", () => {
    expect(inboxEntryLabel("API usage\nnote")).toBe("API usage");
    expect(inboxEntryLabel(null)).toBe("Sans libellé");
    expect(
      describeDimensions({ projectId: "p-1", repository: "org/api", tags: ["ia"] }, new Map([["p-1", "Refonte"]])),
    ).toBe("Projet Refonte · Dépôt org/api · Étiquettes ia");
    expect(describeDimensions({})).toBe("—");
  });
});
