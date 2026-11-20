import Decimal from "decimal.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseDateOnly } from "@/lib/dates";

const project = { findMany: vi.fn() };
const revenueDocument = { findMany: vi.fn() };
const costEntry = { findMany: vi.fn() };

vi.mock("@/lib/db", () => ({ getPrisma: () => ({ project, revenueDocument, costEntry }) }));

const { getProjectProfitability, ProfitabilityForbiddenError } = await import("./service");
const { MAX_PROFITABILITY_ROWS, ProfitabilityInputTooLargeError } = await import("./repository");

const NOVEMBER = { from: parseDateOnly("2026-11-01"), to: parseDateOnly("2026-11-30") };
const as = (role: string) => ({ workspace: { id: "ws-1", role } }) as never;

beforeEach(() => {
  project.findMany.mockReset().mockResolvedValue([{ id: "A", name: "Refonte" }]);
  revenueDocument.findMany.mockReset().mockResolvedValue([
    {
      projectId: "A",
      currency: "EUR",
      kind: "INVOICE",
      amount: new Decimal("100"),
      issuedOn: parseDateOnly("2026-11-05"),
      recognizedOn: null,
      recognizedAmount: null,
    },
  ]);
  costEntry.findMany.mockReset().mockResolvedValue([
    {
      amount: new Decimal("40"),
      currency: "EUR",
      periodStart: parseDateOnly("2026-11-02"),
      projectId: "A",
      allocations: [],
    },
  ]);
});

describe("getProjectProfitability", () => {
  it("computes from the workspace's own rows for the owner", async () => {
    const result = await getProjectProfitability(as("OWNER"), NOVEMBER);

    expect(result.ruleVersion).toBe("v1");
    expect(result.projects[0].contributionMargin.toFixed(2)).toBe("60.00");
    for (const mock of [project.findMany, revenueDocument.findMany, costEntry.findMany]) {
      expect(mock.mock.calls[0][0].where).toMatchObject({ workspaceId: "ws-1" });
    }
  });

  it.each(["ADMIN", "MEMBER", "VIEWER"])("refuses %s before reading anything: margins are confidential", async (role) => {
    await expect(getProjectProfitability(as(role), NOVEMBER)).rejects.toBeInstanceOf(ProfitabilityForbiddenError);
    expect(costEntry.findMany).not.toHaveBeenCalled();
  });

  it("refuses a truncated read rather than computing on part of the data", async () => {
    costEntry.findMany.mockResolvedValue(Array.from({ length: MAX_PROFITABILITY_ROWS + 1 }, () => ({})));
    await expect(getProjectProfitability(as("OWNER"), NOVEMBER)).rejects.toBeInstanceOf(ProfitabilityInputTooLargeError);
  });
});
