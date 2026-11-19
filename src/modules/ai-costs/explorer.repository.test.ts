import Decimal from "decimal.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseDateOnly } from "@/lib/dates";
import { EXPLORER_PAGE_SIZE, parseExplorerFilters, type ExplorerOptions } from "./explorer";
import { currentBillingCycle } from "./overview";

const groupBy = vi.fn();
const count = vi.fn();
const findMany = vi.fn();

vi.mock("@/lib/db", () => ({ getPrisma: () => ({ costEntry: { groupBy, count, findMany } }) }));

const { listExplorerOptions, readCostExplorer } = await import("./repository");

const cycle = currentBillingCycle(parseDateOnly("2026-11-19"));
const options = { provider: ["openai"], project: ["proj-a"] } as unknown as ExplorerOptions;

beforeEach(() => {
  groupBy.mockReset().mockResolvedValue([]);
  count.mockReset().mockResolvedValue(0);
  findMany.mockReset().mockResolvedValue([]);
});

describe("readCostExplorer", () => {
  it("groups, counts and pages the same workspace-scoped filter", async () => {
    groupBy.mockResolvedValue([
      { sourceProvider: "openai", currency: "EUR", _sum: { amount: new Decimal("4.20") }, _count: { _all: 3 } },
      { sourceProvider: null, currency: "EUR", _sum: { amount: null }, _count: { _all: 0 } },
    ]);
    const filters = parseExplorerFilters({ project: "proj-a" }, options, cycle);

    const result = await readCostExplorer("ws-1", filters);

    const where = groupBy.mock.calls[0][0].where;
    expect(where).toMatchObject({ workspaceId: "ws-1", projectId: "proj-a" });
    expect(count.mock.calls[0][0].where).toBe(where);
    expect(findMany.mock.calls[0][0].where).toBe(where);
    expect(groupBy.mock.calls[0][0].by).toEqual(["sourceProvider", "currency"]);
    expect(result.groups).toEqual([
      { value: "openai", currency: "EUR", amount: new Decimal("4.20"), count: 3 },
      { value: null, currency: "EUR", amount: 0, count: 0 },
    ]);
  });

  it("bounds the page size and clamps a page past the end", async () => {
    count.mockResolvedValue(EXPLORER_PAGE_SIZE + 1);
    const filters = parseExplorerFilters({ page: "40" }, options, cycle);

    const result = await readCostExplorer("ws-1", filters);

    expect(result).toMatchObject({ page: 2, pageCount: 2, total: EXPLORER_PAGE_SIZE + 1 });
    expect(findMany.mock.calls[0][0]).toMatchObject({ skip: EXPLORER_PAGE_SIZE, take: EXPLORER_PAGE_SIZE });
  });
});

describe("listExplorerOptions", () => {
  it("reads each dimension's distinct values from the workspace only, bounded", async () => {
    findMany.mockImplementation(async ({ select }: { select: Record<string, true> }) =>
      "sourceProvider" in select ? [{ sourceProvider: "openai" }] : [],
    );

    const result = await listExplorerOptions("ws-1");

    expect(result.provider).toEqual(["openai"]);
    expect(result.project).toEqual([]);
    for (const [args] of findMany.mock.calls) {
      expect(args.where.workspaceId).toBe("ws-1");
      expect(args.take).toBeLessThanOrEqual(200);
    }
  });
});
