import { describe, expect, it } from "vitest";
import {
  COST_DIMENSION_KEYS,
  EMPTY_COST_DIMENSIONS,
  fromCostDimensionColumns,
  hasCostDimension,
  InvalidCostDimensionError,
  MAX_COST_TAG_COUNT,
  normalizeCostDimensions,
  toCostDimensionColumns,
  UnsafeCostDimensionError,
} from "./dimensions";

describe("cost dimensions", () => {
  it("treats an absent set as empty", () => {
    expect(normalizeCostDimensions(undefined)).toEqual(EMPTY_COST_DIMENSIONS);
    expect(normalizeCostDimensions(null)).toEqual(EMPTY_COST_DIMENSIONS);
    expect(hasCostDimension(EMPTY_COST_DIMENSIONS)).toBe(false);
  });

  it("trims every typed dimension and keeps the known ones", () => {
    const dimensions = normalizeCostDimensions({
      projectId: " project-1 ",
      clientId: "client-1",
      repository: "owner/repo",
      developerId: "dev-1",
      agentId: "agent-1",
      issueId: "issue-1",
      pullRequestId: "pr-1",
      environment: "production",
    });

    expect(COST_DIMENSION_KEYS.every((key) => dimensions[key] !== null)).toBe(true);
    expect(dimensions.projectId).toBe("project-1");
    expect(hasCostDimension(dimensions)).toBe(true);
  });

  it("trims, de-duplicates and sorts tags", () => {
    const dimensions = normalizeCostDimensions({
      tags: [" beta ", "alpha", "beta"],
    });

    expect(dimensions.tags).toEqual(["alpha", "beta"]);
    expect(Object.isFrozen(dimensions.tags)).toBe(true);
  });

  it("round-trips through the column shape", () => {
    const dimensions = normalizeCostDimensions({
      projectId: "project-1",
      tags: ["tag"],
    });

    expect(fromCostDimensionColumns(toCostDimensionColumns(dimensions))).toEqual(
      dimensions,
    );
  });

  it("refuses malformed values without echoing them", () => {
    expect(() => normalizeCostDimensions({ projectId: 42 } as never)).toThrow(
      InvalidCostDimensionError,
    );
    expect(() => normalizeCostDimensions({ projectId: "   " })).toThrow(
      InvalidCostDimensionError,
    );
    expect(() =>
      normalizeCostDimensions({ projectId: "x".repeat(129) }),
    ).toThrow(InvalidCostDimensionError);
    expect(() =>
      normalizeCostDimensions({ projectId: "bad\u0000value" }),
    ).toThrow(InvalidCostDimensionError);
    expect(() => normalizeCostDimensions({ tags: "not-an-array" } as never)).toThrow(
      InvalidCostDimensionError,
    );
    expect(() =>
      normalizeCostDimensions({
        tags: Array.from({ length: MAX_COST_TAG_COUNT + 1 }, (_, index) =>
          `tag-${index}`,
        ),
      }),
    ).toThrow(InvalidCostDimensionError);
  });

  it("refuses token-shaped identifiers, naming only the field", () => {
    try {
      normalizeCostDimensions({ issueId: "sk-abcdefghijklmnop" });
      expect.unreachable("the dimension should have been refused");
    } catch (error) {
      expect(error).toBeInstanceOf(UnsafeCostDimensionError);
      expect((error as Error).message).not.toContain("sk-abcdefghijklmnop");
    }
  });
});
