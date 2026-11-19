import Decimal from "decimal.js";
import { describe, expect, it, vi } from "vitest";

const groupByMock = vi.fn();
const queryRawMock = vi.fn();

vi.mock("@/lib/db", () => ({
  getPrisma: () => ({ costEntry: { groupBy: groupByMock }, $queryRaw: queryRawMock }),
}));

const { summarizeUnallocatedCosts } = await import("./repository");

describe("summarizeUnallocatedCosts", () => {
  it("keeps currencies apart and reconciles total = allocated + unallocated, finalized included", async () => {
    groupByMock.mockResolvedValue([
      { currency: "EUR", status: "DRAFT", _sum: { amount: new Decimal("150.00") }, _count: { _all: 2 } },
      { currency: "EUR", status: "FINALIZED", _sum: { amount: new Decimal("50.00") }, _count: { _all: 1 } },
      { currency: "USD", status: "DRAFT", _sum: { amount: new Decimal("-20.00") }, _count: { _all: 1 } },
    ]);
    queryRawMock.mockResolvedValue([{ currency: "EUR", allocated: new Decimal("120.00") }]);

    const summary = await summarizeUnallocatedCosts("ws-1");

    expect(groupByMock).toHaveBeenCalledWith(expect.objectContaining({ where: { workspaceId: "ws-1" } }));
    expect(
      summary.map((row) => [row.currency, row.total.toFixed(2), row.allocated.toFixed(2), row.unallocated.toFixed(2), row.draftCount, row.entryCount]),
    ).toEqual([
      ["EUR", "200.00", "120.00", "80.00", 2, 3],
      ["USD", "-20.00", "0.00", "-20.00", 1, 1],
    ]);
    for (const row of summary) {
      expect(row.allocated.plus(row.unallocated).equals(row.total)).toBe(true);
    }
  });

  it("returns no row for an empty ledger rather than a zero total", async () => {
    groupByMock.mockResolvedValue([]);
    queryRawMock.mockResolvedValue([]);
    expect(await summarizeUnallocatedCosts("ws-1")).toEqual([]);
  });
});
