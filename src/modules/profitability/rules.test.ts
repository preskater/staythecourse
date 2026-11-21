import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { parseDateOnly } from "@/lib/dates";
import {
  calculateProfitability,
  PROFITABILITY_RULE_VERSIONS,
  UnknownProfitabilityRuleVersionError,
  type CostEntryInput,
  type ProfitabilityInputs,
  type ProfitabilityResult,
  type RevenueDocumentInput,
} from "./rules";

const d = parseDateOnly;
const NOVEMBER = { from: d("2026-11-01"), to: d("2026-11-30") };

function invoice(projectId: string, amount: string, issuedOn: string, extra: Partial<RevenueDocumentInput> = {}): RevenueDocumentInput {
  return { projectId, currency: "EUR", kind: "INVOICE", amount: new Decimal(amount), issuedOn: d(issuedOn), recognizedOn: null, recognizedAmount: null, ...extra };
}

function cost(amount: string, periodStart: string, projectId: string | null, allocations: [string | null, string][] = [], currency = "EUR"): CostEntryInput {
  return {
    amount: new Decimal(amount),
    currency,
    periodStart: d(periodStart),
    projectId,
    allocations: allocations.map(([project, value]) => ({ projectId: project, amount: new Decimal(value) })),
  };
}

/** Fictitious golden scenario: every figure below is computed by hand in the test names. */
const GOLDEN: ProfitabilityInputs = {
  projects: [
    { id: "A", name: "Refonte" },
    { id: "B", name: "Audit" },
  ],
  revenueDocuments: [
    invoice("A", "1000.00", "2026-11-05"),
    { ...invoice("A", "100.00", "2026-11-20"), kind: "CREDIT_NOTE" },
    // Issued in October, recognised in November through its snapshot.
    invoice("B", "500.00", "2026-10-28", { recognizedOn: d("2026-11-02"), recognizedAmount: new Decimal("300.00") }),
    invoice("B", "200.00", "2026-12-01"),
    { ...invoice("A", "50.00", "2026-11-10"), currency: "USD" },
  ],
  costEntries: [
    cost("400.00", "2026-11-03", "A"),
    cost("300.00", "2026-11-04", null, [["A", "100.00"], ["B", "150.00"]]),
    cost("120.00", "2026-11-06", "B", [["A", "20.00"]]),
    cost("-30.00", "2026-11-07", null),
    cost("400.00", "2026-10-31", "A"),
    cost("10.00", "2026-11-08", null, [], "USD"),
  ],
};

const figures = (result: ProfitabilityResult) =>
  result.projects.map((row) => [
    row.currency,
    row.projectName,
    row.revenue.toFixed(2),
    row.directCost.toFixed(2),
    row.contributionMargin.toFixed(2),
    row.overhead.toFixed(2),
    row.result.toFixed(2),
  ]);

describe("calculateProfitability — golden values (rules v1)", () => {
  it("recognises revenue, attributes costs once, spreads overhead by revenue", () => {
    const result = calculateProfitability(GOLDEN, NOVEMBER);

    expect(result.ruleVersion).toBe("v1");
    // EUR: A revenue 1000 − 100 = 900, direct 400 + 100 + 20 = 520; B revenue 300
    // (snapshot), direct 150 + 100 = 250. Overhead 50 (unallocated remainder) − 30
    // (refund) = 20, split 900:300 → 15 and 5. USD: A 50 revenue, 10 overhead.
    expect(figures(result)).toEqual([
      ["EUR", "Audit", "300.00", "250.00", "50.00", "5.00", "45.00"],
      ["EUR", "Refonte", "900.00", "520.00", "380.00", "15.00", "365.00"],
      ["USD", "Refonte", "50.00", "0.00", "50.00", "10.00", "40.00"],
    ]);
  });

  it("conserves every cost of the range, per currency", () => {
    const result = calculateProfitability(GOLDEN, NOVEMBER);

    for (const currency of result.currencies) {
      expect(currency.directCost.plus(currency.overheadAllocated).plus(currency.overheadUnallocated).toFixed(2)).toBe(
        currency.totalCost.toFixed(2),
      );
    }
    expect(result.currencies.map((row) => [row.currency, row.totalCost.toFixed(2), row.revenue.toFixed(2)])).toEqual([
      ["EUR", "790.00", "1200.00"],
      ["USD", "10.00", "50.00"],
    ]);
  });
});

describe("determinism", () => {
  it("gives identical outputs for the same inputs, whatever their order", () => {
    const shuffled: ProfitabilityInputs = {
      projects: [...GOLDEN.projects].reverse(),
      revenueDocuments: [...GOLDEN.revenueDocuments].reverse(),
      costEntries: [...GOLDEN.costEntries].reverse(),
    };

    expect(calculateProfitability(shuffled, NOVEMBER)).toEqual(calculateProfitability(GOLDEN, NOVEMBER));
  });
});

describe("allocation edge cases", () => {
  it("keeps overhead unallocated when no project earned revenue, and never shares it with a negative one", () => {
    const result = calculateProfitability(
      {
        projects: [],
        revenueDocuments: [{ ...invoice("A", "100.00", "2026-11-05"), kind: "CREDIT_NOTE" }],
        costEntries: [cost("80.00", "2026-11-05", null), cost("20.00", "2026-11-05", "A")],
      },
      NOVEMBER,
    );

    expect(result.currencies[0]).toMatchObject({ currency: "EUR" });
    expect(result.currencies[0].overheadUnallocated.toFixed(2)).toBe("80.00");
    expect(result.projects[0]).toMatchObject({ projectId: "A", projectName: null });
    expect(result.projects[0].result.toFixed(2)).toBe("-120.00");
  });

  it("splits indivisible cents by largest remainder and still conserves", () => {
    const result = calculateProfitability(
      {
        projects: [],
        revenueDocuments: [invoice("A", "1.00", "2026-11-01"), invoice("B", "1.00", "2026-11-01"), invoice("C", "1.00", "2026-11-01")],
        costEntries: [cost("0.10", "2026-11-01", null)],
      },
      NOVEMBER,
    );

    expect(result.projects.map((row) => row.overhead.toFixed(2))).toEqual(["0.04", "0.03", "0.03"]);
    expect(result.currencies[0].overheadAllocated.toFixed(2)).toBe("0.10");
  });

  it("counts a fully allocated entry only through its allocations", () => {
    const result = calculateProfitability(
      { projects: [], revenueDocuments: [], costEntries: [cost("100.00", "2026-11-01", "A", [["B", "100.00"]])] },
      NOVEMBER,
    );

    expect(result.projects.map((row) => [row.projectId, row.directCost.toFixed(2)])).toEqual([["B", "100.00"]]);
  });

  it("includes both bounds of the period and nothing outside", () => {
    const result = calculateProfitability(
      {
        projects: [],
        revenueDocuments: [invoice("A", "1.00", "2026-11-01"), invoice("A", "2.00", "2026-11-30"), invoice("A", "4.00", "2026-12-01")],
        costEntries: [],
      },
      NOVEMBER,
    );

    expect(result.projects[0].revenue.toFixed(2)).toBe("3.00");
  });

  it("returns empty lists, not zeros, when nothing happened", () => {
    expect(calculateProfitability({ projects: [{ id: "A", name: "x" }], revenueDocuments: [], costEntries: [] }, NOVEMBER)).toMatchObject({
      projects: [],
      currencies: [],
    });
  });
});

describe("rule versions", () => {
  it("records the version used and refuses an unknown one", () => {
    expect(PROFITABILITY_RULE_VERSIONS).toContain("v1");
    expect(calculateProfitability(GOLDEN, NOVEMBER, "v1").ruleVersion).toBe("v1");
    expect(() => calculateProfitability(GOLDEN, NOVEMBER, "v0")).toThrow(UnknownProfitabilityRuleVersionError);
  });
});
