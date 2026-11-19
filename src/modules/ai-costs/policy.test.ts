import { describe, expect, it } from "vitest";
import { InvalidAllocationMathError } from "./allocation";
import {
  InvalidAllocationPolicyError,
  planPolicyAllocations,
  revenueMeasures,
  validatePolicyName,
  validatePolicyRationale,
  validatePolicyTargets,
  type AllocationPolicyKind,
  type PolicyTargetInput,
} from "./policy";

const three: PolicyTargetInput[] = [
  { dimensions: { projectId: "p-a" } },
  { dimensions: { projectId: "p-b" } },
  { dimensions: { projectId: "p-c" } },
];

function plan(
  kind: AllocationPolicyKind,
  totalCents: bigint,
  measures?: string[] | null,
  targets: PolicyTargetInput[] = three,
) {
  return planPolicyAllocations(kind, validatePolicyTargets(kind, targets), totalCents, measures).map(
    (row) => [row.dimensions.projectId, row.amountCents, row.measure.toString()],
  );
}

describe("planPolicyAllocations — golden splits", () => {
  it("EQUAL_SEAT: 100.00 over 1/1/1 seats gives the extra cent to the first target", () => {
    expect(plan("EQUAL_SEAT", BigInt(10000), ["1", "1", "1"])).toEqual([
      ["p-a", BigInt(3334), "1"],
      ["p-b", BigInt(3333), "1"],
      ["p-c", BigInt(3333), "1"],
    ]);
  });

  it("EQUAL_SEAT: seats weigh the split and a zero-seat target gets nothing", () => {
    expect(plan("EQUAL_SEAT", BigInt(1000), ["2", "1", "0"])).toEqual([
      ["p-a", BigInt(667), "2"],
      ["p-b", BigInt(333), "1"],
    ]);
  });

  it("USAGE_WEIGHTED: decimal usage, largest remainder rounding", () => {
    expect(plan("USAGE_WEIGHTED", BigInt(1000), ["0.5", "1.25", "1.25"])).toEqual([
      ["p-a", BigInt(167), "0.5"],
      ["p-b", BigInt(417), "1.25"],
      ["p-c", BigInt(416), "1.25"],
    ]);
  });

  it("USAGE_WEIGHTED: a credit is split with its sign", () => {
    expect(plan("USAGE_WEIGHTED", BigInt(-1000), ["1", "1", "1"])).toEqual([
      ["p-a", BigInt(-334), "1"],
      ["p-b", BigInt(-333), "1"],
      ["p-c", BigInt(-333), "1"],
    ]);
  });

  it("REVENUE_WEIGHTED: splits by the measured revenue", () => {
    expect(plan("REVENUE_WEIGHTED", BigInt(9000), ["3000.00", "1500.00", "0"])).toEqual([
      ["p-a", BigInt(6000), "3000"],
      ["p-b", BigInt(3000), "1500"],
    ]);
  });

  it("FIXED_PERCENTAGE: below 100 % the rest stays unallocated", () => {
    const targets = [
      { dimensions: { projectId: "p-a" }, percent: "33.33" },
      { dimensions: { projectId: "p-b" }, percent: "33.33" },
    ];
    expect(plan("FIXED_PERCENTAGE", BigInt(10000), null, targets)).toEqual([
      ["p-a", BigInt(3333), "33.33"],
      ["p-b", BigInt(3333), "33.33"],
    ]);
  });

  it("FIXED_PERCENTAGE: at 100 % every cent is allocated", () => {
    const targets = [
      { dimensions: { projectId: "p-a" }, percent: "50" },
      { dimensions: { projectId: "p-b" }, percent: "25" },
      { dimensions: { projectId: "p-c" }, percent: "25" },
    ];
    const rows = plan("FIXED_PERCENTAGE", BigInt(1001), null, targets);
    expect(rows).toEqual([
      ["p-a", BigInt(501), "50"],
      ["p-b", BigInt(250), "25"],
      ["p-c", BigInt(250), "25"],
    ]);
  });

  it("MANUAL: amounts are taken as given, the rest stays unallocated", () => {
    expect(plan("MANUAL", BigInt(10000), ["40.00", "35.50", "0"])).toEqual([
      ["p-a", BigInt(4000), "40"],
      ["p-b", BigInt(3550), "35.5"],
    ]);
  });

  it("MANUAL: refuses more than the amount and the wrong sign", () => {
    expect(() => plan("MANUAL", BigInt(1000), ["6", "5", "0"])).toThrow(InvalidAllocationMathError);
    expect(() => plan("MANUAL", BigInt(1000), ["-1", "0", "0"])).toThrow(InvalidAllocationMathError);
  });

  it("is deterministic: identical inputs give identical output", () => {
    const first = plan("USAGE_WEIGHTED", BigInt(99999), ["7", "11", "13"]);
    const second = plan("USAGE_WEIGHTED", BigInt(99999), ["7", "11", "13"]);
    expect(second).toEqual(first);
    expect(first.reduce((sum, row) => sum + (row[1] as bigint), BigInt(0))).toBe(BigInt(99999));
  });
});

describe("planPolicyAllocations — empty and invalid inputs", () => {
  it("refuses a zero amount", () => {
    expect(() => plan("EQUAL_SEAT", BigInt(0), ["1", "1", "1"])).toThrow(/nothing left/);
  });

  it("refuses when no target has any weight instead of guessing", () => {
    expect(() => plan("USAGE_WEIGHTED", BigInt(100), ["0", "0", "0"])).toThrow(/no target has any weight/);
  });

  it("needs one measure per target", () => {
    expect(() => plan("EQUAL_SEAT", BigInt(100), ["1"])).toThrow(InvalidAllocationPolicyError);
    expect(() => plan("EQUAL_SEAT", BigInt(100), null)).toThrow(InvalidAllocationPolicyError);
  });

  it("refuses fractional seats, negative usage and measures on a fixed percentage", () => {
    expect(() => plan("EQUAL_SEAT", BigInt(100), ["1.5", "1", "1"])).toThrow(/whole numbers/);
    expect(() => plan("USAGE_WEIGHTED", BigInt(100), ["-1", "1", "1"])).toThrow(/negative/);
    const targets = [{ dimensions: { projectId: "p-a" }, percent: "10" }];
    expect(() => plan("FIXED_PERCENTAGE", BigInt(100), ["1"], targets)).toThrow(/no measure/);
  });
});

describe("validatePolicyTargets", () => {
  it("requires at least one target with a dimension", () => {
    expect(() => validatePolicyTargets("EQUAL_SEAT", [])).toThrow(/at least one target/);
    expect(() => validatePolicyTargets("EQUAL_SEAT", [{ dimensions: {} }])).toThrow(/dimension/);
  });

  it("refuses duplicate targets", () => {
    expect(() =>
      validatePolicyTargets("EQUAL_SEAT", [
        { dimensions: { projectId: "p-a" } },
        { dimensions: { projectId: "p-a" } },
      ]),
    ).toThrow(/duplicate/);
  });

  it("checks percentages only on fixed-percentage policies", () => {
    expect(() =>
      validatePolicyTargets("FIXED_PERCENTAGE", [
        { dimensions: { projectId: "p-a" }, percent: "60" },
        { dimensions: { projectId: "p-b" }, percent: "40.01" },
      ]),
    ).toThrow(/more than 100/);
    expect(() =>
      validatePolicyTargets("FIXED_PERCENTAGE", [{ dimensions: { projectId: "p-a" }, percent: "0" }]),
    ).toThrow(/above 0/);
    expect(() =>
      validatePolicyTargets("FIXED_PERCENTAGE", [{ dimensions: { projectId: "p-a" }, percent: "1.234" }]),
    ).toThrow(/decimals/);
    expect(() =>
      validatePolicyTargets("EQUAL_SEAT", [{ dimensions: { projectId: "p-a" }, percent: "10" }]),
    ).toThrow(/only fixed-percentage/);
  });

  it("requires a project on every revenue-weighted target", () => {
    expect(() =>
      validatePolicyTargets("REVENUE_WEIGHTED", [{ dimensions: { repository: "org/repo" } }]),
    ).toThrow(/project/);
  });

  it("round-trips through JSON unchanged", () => {
    const targets = validatePolicyTargets("FIXED_PERCENTAGE", [
      { dimensions: { projectId: "p-a", tags: ["b", "a"] }, percent: "12.5" },
    ]);
    const stored = JSON.parse(JSON.stringify(targets));
    expect(validatePolicyTargets("FIXED_PERCENTAGE", stored)).toEqual(targets);
    expect(targets[0].percent).toBe("12.50");
  });
});

describe("name and rationale", () => {
  it("trims, requires and bounds the text", () => {
    expect(validatePolicyName("  Sièges Cursor ")).toBe("Sièges Cursor");
    expect(() => validatePolicyName("   ")).toThrow(/required/);
    expect(() => validatePolicyRationale("x".repeat(2001))).toThrow(/at most/);
  });
});

describe("revenueMeasures", () => {
  const targets = validatePolicyTargets("REVENUE_WEIGHTED", [
    { dimensions: { projectId: "p-a" } },
    { dimensions: { projectId: "p-b" } },
  ]);
  const window = { currency: "EUR", periodStart: "2026-03-01", periodEnd: "2026-03-31" };

  it("nets credit notes, keeps the period inclusive and ignores other projects", () => {
    const measures = revenueMeasures(
      targets,
      [
        { projectId: "p-a", kind: "INVOICE", currency: "EUR", amount: "1000.00", issuedOn: "2026-03-01" },
        { projectId: "p-a", kind: "CREDIT_NOTE", currency: "EUR", amount: "200.00", issuedOn: "2026-03-31" },
        { projectId: "p-a", kind: "INVOICE", currency: "EUR", amount: "999.00", issuedOn: "2026-04-01" },
        { projectId: "p-z", kind: "INVOICE", currency: "USD", amount: "5.00", issuedOn: "2026-03-10" },
      ],
      window,
    );
    expect(measures.map(String)).toEqual(["800", "0"]);
  });

  it("refuses revenue in another currency rather than converting it", () => {
    expect(() =>
      revenueMeasures(
        targets,
        [{ projectId: "p-b", kind: "INVOICE", currency: "USD", amount: "10", issuedOn: "2026-03-05" }],
        window,
      ),
    ).toThrow(/USD/);
  });

  it("a net negative revenue is refused by the split", () => {
    const measures = revenueMeasures(
      targets,
      [{ projectId: "p-a", kind: "CREDIT_NOTE", currency: "EUR", amount: "10", issuedOn: "2026-03-05" }],
      window,
    );
    expect(() =>
      planPolicyAllocations("REVENUE_WEIGHTED", targets, BigInt(100), measures),
    ).toThrow(/negative/);
  });
});
