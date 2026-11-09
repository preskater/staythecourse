import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import {
  approveRefusedReason,
  compareEstimateVersions,
  estimateTotal,
  estimateVersionInputSchema,
  nextVersionNumber,
  parseEstimateItems,
  versionKindRefusedReason,
  type EstimateItemRecord,
} from "./estimates";

function item(label: string, amount: string, position = 0): EstimateItemRecord {
  return { label, amount: new Decimal(amount), position };
}

describe("parseEstimateItems", () => {
  it("parses one line per item and keeps signed amounts", () => {
    const parsed = parseEstimateItems("Développement | 12 000,00\nDesign | 3 500\nRéduction | -1 500,50");

    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.items).toHaveLength(3);
    expect(parsed.ok && parsed.items[0].amount.toFixed(2)).toBe("12000.00");
    expect(parsed.ok && parsed.items[2].amount.toFixed(2)).toBe("-1500.50");
  });

  it("ignores blank lines", () => {
    const parsed = parseEstimateItems("\n  Dev | 100  \n\n");

    expect(parsed.ok && parsed.items).toHaveLength(1);
    expect(parsed.ok && parsed.items[0].label).toBe("Dev");
  });

  it("refuses an empty text area", () => {
    const parsed = parseEstimateItems("   \n ");

    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? "" : parsed.message).toContain("au moins une ligne");
  });

  it("names the line missing its separator", () => {
    const parsed = parseEstimateItems("Dev | 100\nSans séparateur");

    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? "" : parsed.message).toContain("Ligne 2");
  });

  it("refuses an empty label", () => {
    const parsed = parseEstimateItems(" | 100");

    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? "" : parsed.message).toContain("libellé");
  });

  it("refuses a duplicate label, case-insensitively", () => {
    const parsed = parseEstimateItems("Dev | 100\ndev | 200");

    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? "" : parsed.message).toContain("deux fois");
  });

  it("refuses an invalid amount and names the line", () => {
    const parsed = parseEstimateItems("Dev | 100\nDesign | abc");

    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? "" : parsed.message).toContain("Ligne 2");
  });
});

describe("estimateTotal", () => {
  it("sums signed lines exactly", () => {
    const total = estimateTotal([item("A", "1000.00"), item("B", "-250.50")]);

    expect(total.toFixed(2)).toBe("749.50");
  });

  it("returns zero for an empty version", () => {
    expect(estimateTotal([]).toFixed(2)).toBe("0.00");
  });
});

describe("compareEstimateVersions", () => {
  const before = [
    item("A", "100.00", 0),
    item("B", "200.00", 1),
    item("C", "300.00", 2),
  ];
  const after = [
    item("D", "50.00", 0),
    item("A", "120.00", 1),
    item("C", "300.00", 2),
  ];

  it("reports added, removed and changed lines with totals", () => {
    const comparison = compareEstimateVersions(before, after);

    expect(comparison.beforeTotal.toFixed(2)).toBe("600.00");
    expect(comparison.afterTotal.toFixed(2)).toBe("470.00");
    expect(comparison.delta.toFixed(2)).toBe("-130.00");

    expect(comparison.added.map((line) => line.label)).toEqual(["D"]);
    expect(comparison.added[0].delta.toFixed(2)).toBe("50.00");

    expect(comparison.removed.map((line) => line.label)).toEqual(["B"]);
    expect(comparison.removed[0].delta.toFixed(2)).toBe("-200.00");

    expect(comparison.changed.map((line) => line.label)).toEqual(["A"]);
    expect(comparison.changed[0].before?.toFixed(2)).toBe("100.00");
    expect(comparison.changed[0].after?.toFixed(2)).toBe("120.00");
    expect(comparison.changed[0].delta.toFixed(2)).toBe("20.00");
  });

  it("omits unchanged lines and reports no difference", () => {
    const comparison = compareEstimateVersions(before, before);

    expect(comparison.added).toEqual([]);
    expect(comparison.removed).toEqual([]);
    expect(comparison.changed).toEqual([]);
    expect(comparison.delta.toFixed(2)).toBe("0.00");
  });

  it("is reproducible from the same stored versions", () => {
    const first = compareEstimateVersions(before, after);
    const second = compareEstimateVersions(before, after);

    expect(
      [first.beforeTotal, first.afterTotal, first.delta].map((value) => value.toFixed(2)),
    ).toEqual([second.beforeTotal, second.afterTotal, second.delta].map((value) => value.toFixed(2)));
    expect(first.changed.map((line) => line.label)).toEqual(
      second.changed.map((line) => line.label),
    );
  });

  it("sorts each group by label", () => {
    const comparison = compareEstimateVersions(
      [item("Z", "1.00"), item("A", "1.00")],
      [item("Y", "1.00"), item("B", "1.00")],
    );

    expect(comparison.removed.map((line) => line.label)).toEqual(["A", "Z"]);
    expect(comparison.added.map((line) => line.label)).toEqual(["B", "Y"]);
  });
});

describe("nextVersionNumber", () => {
  it("starts at 1 and follows the highest existing version", () => {
    expect(nextVersionNumber([])).toBe(1);
    expect(nextVersionNumber([{ versionNumber: 1 }])).toBe(2);
    expect(nextVersionNumber([{ versionNumber: 3 }, { versionNumber: 1 }])).toBe(4);
  });
});

describe("versionKindRefusedReason", () => {
  it("requires the baseline first", () => {
    expect(versionKindRefusedReason(0, "BASELINE")).toBeNull();
    expect(versionKindRefusedReason(0, "REVISION")).toContain("première version");
    expect(versionKindRefusedReason(0, "CHANGE_REQUEST")).toContain("première version");
  });

  it("refuses a second baseline and accepts later revisions or change requests", () => {
    expect(versionKindRefusedReason(1, "BASELINE")).toContain("existe déjà");
    expect(versionKindRefusedReason(1, "REVISION")).toBeNull();
    expect(versionKindRefusedReason(1, "CHANGE_REQUEST")).toBeNull();
  });
});

describe("approveRefusedReason", () => {
  it("accepts a draft only", () => {
    expect(approveRefusedReason("DRAFT")).toBeNull();
    expect(approveRefusedReason("APPROVED")).toContain("déjà approuvée");
    expect(approveRefusedReason("SUPERSEDED")).toContain("remplacée");
  });
});

describe("estimateVersionInputSchema", () => {
  const base = {
    projectId: "project-1",
    kind: "BASELINE",
    assumptions: "",
    notes: "",
    items: "Développement | 1 000,00",
  };

  it("accepts a valid version and normalises empty optional text", () => {
    const parsed = estimateVersionInputSchema.safeParse(base);

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.assumptions).toBeNull();
    expect(parsed.success && parsed.data.notes).toBeNull();
  });

  it("requires a project, a known kind and at least one line", () => {
    expect(estimateVersionInputSchema.safeParse({ ...base, projectId: "" }).success).toBe(false);
    expect(estimateVersionInputSchema.safeParse({ ...base, kind: "OTHER" }).success).toBe(false);
    expect(estimateVersionInputSchema.safeParse({ ...base, items: "" }).success).toBe(false);
  });
});
