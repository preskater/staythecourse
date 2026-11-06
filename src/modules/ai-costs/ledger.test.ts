import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { ACTUALITIES } from "./actuality";
import {
  assertCostEntryEditable,
  FinalizedCostEntryError,
  fromStoredActuality,
  InvalidCostAllocationError,
  InvalidCostEntryError,
  prepareCostAllocation,
  prepareCostAllocationUpdate,
  toStoredActuality,
  validateCostAllocationShape,
  validateCostEntryInput,
} from "./ledger";

const CAPTURED_AT = "2026-01-01T00:00:00.000Z";

function entryInput(overrides: Record<string, unknown> = {}) {
  return {
    amount: "120.50",
    currency: "EUR",
    actuality: "observed",
    source: { kind: "manual", enteredBy: "owner-1", capturedAt: CAPTURED_AT },
    periodStart: "2026-03-01",
    periodEnd: "2026-03-31",
    notes: "  Facture fictive  ",
    dimensions: { projectId: "project-1", tags: ["cloud"] },
    ...overrides,
  } as never;
}

describe("validateCostEntryInput", () => {
  it("normalises a complete entry", () => {
    const entry = validateCostEntryInput(entryInput());

    expect(entry.amount.amount.toFixed(2)).toBe("120.50");
    expect(entry.amount.currency).toBe("EUR");
    expect(entry.actuality).toBe("observed");
    expect(entry.source).toMatchObject({ kind: "manual", enteredBy: "owner-1" });
    expect(entry.periodStart).toBe("2026-03-01");
    expect(entry.periodEnd).toBe("2026-03-31");
    expect(entry.notes).toBe("Facture fictive");
    expect(entry.dimensions.projectId).toBe("project-1");
    expect(entry.dimensions.tags).toEqual(["cloud"]);
  });

  it("rounds once at the boundary and keeps the original currency", () => {
    const entry = validateCostEntryInput(entryInput({ amount: "0.005" }));
    expect(entry.amount.amount.toFixed(2)).toBe("0.01");
    expect(entry.amount.currency).toBe("EUR");
  });

  it("accepts a negative amount (a credit or refund)", () => {
    const entry = validateCostEntryInput(entryInput({ amount: "-25.00" }));
    expect(entry.amount.amount.toFixed(2)).toBe("-25.00");
  });

  it("refuses a zero amount, an unsupported currency and an unknown actuality", () => {
    expect(() => validateCostEntryInput(entryInput({ amount: "0" }))).toThrow(
      InvalidCostEntryError,
    );
    expect(() => validateCostEntryInput(entryInput({ currency: "JPY" }))).toThrow();
    expect(() => validateCostEntryInput(entryInput({ actuality: "OBSERVED" }))).toThrow();
  });

  it("refuses an impossible period", () => {
    expect(() =>
      validateCostEntryInput(
        entryInput({ periodStart: "2026-03-31", periodEnd: "2026-03-01" }),
      ),
    ).toThrow(InvalidCostEntryError);
  });

  it("normalises notes and clears an empty one", () => {
    expect(
      validateCostEntryInput(entryInput({ notes: "   " })).notes,
    ).toBeNull();
    expect(
      validateCostEntryInput(entryInput({ notes: null })).notes,
    ).toBeNull();
  });

  it("refuses notes that are too long or carry control characters", () => {
    expect(() =>
      validateCostEntryInput(entryInput({ notes: "x".repeat(2001) })),
    ).toThrow(InvalidCostEntryError);
    expect(() =>
      validateCostEntryInput(entryInput({ notes: "bad\u0000note" })),
    ).toThrow(InvalidCostEntryError);
  });

  it("refuses a token-shaped source or dimension", () => {
    expect(() =>
      validateCostEntryInput(
        entryInput({
          source: {
            kind: "manual",
            enteredBy: "ghp_abcdefghijklmnop",
            capturedAt: CAPTURED_AT,
          },
        }),
      ),
    ).toThrow();
    expect(() =>
      validateCostEntryInput(
        entryInput({ dimensions: { projectId: "sk-abcdefghijklmnop" } }),
      ),
    ).toThrow();
  });
});

describe("allocation validation", () => {
  it("requires at least one dimension and a positive entry id", () => {
    expect(
      validateCostAllocationShape({
        entryId: " entry-1 ",
        amount: "12.34",
        dimensions: { projectId: "project-1" },
      }),
    ).toMatchObject({ entryId: "entry-1" });

    expect(() =>
      validateCostAllocationShape({
        entryId: "entry-1",
        amount: "12.34",
        dimensions: {},
      }),
    ).toThrow(InvalidCostAllocationError);

    expect(() =>
      validateCostAllocationShape({
        entryId: "   ",
        amount: "12.34",
        dimensions: { projectId: "project-1" },
      }),
    ).toThrow(InvalidCostAllocationError);
  });

  it("inherits the entry currency and rounds once", () => {
    const allocation = prepareCostAllocation(
      {
        entryId: "entry-1",
        amount: "33.335",
        dimensions: { clientId: "client-1" },
      },
      "USD",
    );

    expect(allocation.amount.amount.toFixed(2)).toBe("33.34");
    expect(allocation.amount.currency).toBe("USD");
    expect(allocation.dimensions.clientId).toBe("client-1");
  });

  it("refuses a zero allocation", () => {
    expect(() =>
      prepareCostAllocation(
        { entryId: "entry-1", amount: "0", dimensions: { projectId: "p" } },
        "EUR",
      ),
    ).toThrow(InvalidCostAllocationError);
  });

  it("validates an update without an entry id", () => {
    const updated = prepareCostAllocationUpdate(
      { amount: new Decimal("10.00"), dimensions: { tags: ["ops"] } },
      "EUR",
    );

    expect(updated.amount.amount.toFixed(2)).toBe("10.00");
    expect(updated.dimensions.tags).toEqual(["ops"]);
  });
});

describe("finalization and stored vocabulary", () => {
  it("allows a draft and refuses a finalized entry", () => {
    expect(() => assertCostEntryEditable("DRAFT")).not.toThrow();
    expect(() => assertCostEntryEditable("FINALIZED")).toThrow(
      FinalizedCostEntryError,
    );
  });

  it("round-trips every actuality through the stored vocabulary", () => {
    for (const actuality of ACTUALITIES) {
      expect(fromStoredActuality(toStoredActuality(actuality))).toBe(actuality);
    }
  });

  it("refuses an unknown stored actuality", () => {
    expect(() => fromStoredActuality("SOMETHING")).toThrow();
  });
});
