import Decimal from "decimal.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiBudget } from "./budgets";

const groupBy = vi.fn();
const aiBudget = {
  findMany: vi.fn(),
  findUnique: vi.fn(),
  update: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  deleteMany: vi.fn(),
};

vi.mock("@/lib/db", () => ({ getPrisma: () => ({ costEntry: { groupBy }, aiBudget }) }));

const { deleteAiBudget, listAiBudgets, readAiBudgetSpend, upsertAiBudget, AiBudgetLimitError } = await import(
  "./repository"
);

const START = new Date("2026-11-01T00:00:00Z");
const END = new Date("2026-12-01T00:00:00Z");

function budget(overrides: Partial<AiBudget>): AiBudget {
  return { id: "b", dimension: "workspace", dimensionValue: "", amount: new Decimal(100), currency: "EUR", ...overrides };
}

beforeEach(() => {
  groupBy.mockReset();
  for (const mock of Object.values(aiBudget)) mock.mockReset();
});

describe("readAiBudgetSpend", () => {
  it("matches each budget to its scope and currency, one grouped query per dimension", async () => {
    groupBy.mockImplementation(async ({ by }: { by: string[] }) =>
      by[0] === "currency"
        ? [
            { currency: "EUR", _sum: { amount: new Decimal("42.10") }, _count: { _all: 4 } },
            { currency: "USD", _sum: { amount: new Decimal("9") }, _count: { _all: 1 } },
          ]
        : [
            { sourceProvider: "openai", currency: "EUR", _sum: { amount: new Decimal("30") }, _count: { _all: 2 } },
            { sourceProvider: null, currency: "EUR", _sum: { amount: new Decimal("12.10") }, _count: { _all: 2 } },
          ],
    );

    const spends = await readAiBudgetSpend(
      "ws-1",
      [
        budget({ id: "all" }),
        budget({ id: "openai", dimension: "provider", dimensionValue: "openai" }),
        budget({ id: "anthropic", dimension: "provider", dimensionValue: "anthropic" }),
        budget({ id: "openai-usd", dimension: "provider", dimensionValue: "openai", currency: "USD" }),
      ],
      START,
      END,
    );

    expect(groupBy).toHaveBeenCalledTimes(2);
    for (const [args] of groupBy.mock.calls) {
      expect(args.where).toEqual({ workspaceId: "ws-1", periodStart: { gte: START, lt: END } });
    }
    expect(spends.map((spend) => [spend.budgetId, spend.spent.toFixed(2), spend.entryCount])).toEqual([
      ["all", "42.10", 4],
      ["openai", "30.00", 2],
      // No entry for this provider, nor in this currency: "no data", never a zero spend.
      ["anthropic", "0.00", 0],
      ["openai-usd", "0.00", 0],
    ]);
  });
});

describe("AI budget writes", () => {
  it("lists the workspace's budgets only, bounded, and skips an unknown dimension", async () => {
    aiBudget.findMany.mockResolvedValue([
      { id: "a", dimension: "project", dimensionValue: "p", amount: new Decimal(1), currency: "EUR" },
      { id: "b", dimension: "model", dimensionValue: "gpt", amount: new Decimal(1), currency: "EUR" },
    ]);

    const budgets = await listAiBudgets("ws-1");

    expect(aiBudget.findMany.mock.calls[0][0]).toMatchObject({ where: { workspaceId: "ws-1" }, take: 100 });
    expect(budgets.map((item) => item.id)).toEqual(["a"]);
  });

  it("replaces the cap of an existing scope instead of creating a duplicate", async () => {
    aiBudget.findUnique.mockResolvedValue({ id: "existing" });
    const input = { dimension: "provider" as const, dimensionValue: "openai", amount: new Decimal("250"), currency: "EUR" as const };

    expect(await upsertAiBudget("ws-1", input)).toEqual({ id: "existing", created: false });
    expect(aiBudget.findUnique.mock.calls[0][0].where.workspaceId_dimension_dimensionValue_currency).toMatchObject({
      workspaceId: "ws-1",
    });
    expect(aiBudget.update).toHaveBeenCalledWith({ where: { id: "existing" }, data: { amount: "250.00" } });
    expect(aiBudget.create).not.toHaveBeenCalled();
  });

  it("refuses a new budget past the bound", async () => {
    aiBudget.findUnique.mockResolvedValue(null);
    aiBudget.count.mockResolvedValue(100);
    const input = { dimension: "workspace" as const, dimensionValue: "", amount: new Decimal("1"), currency: "EUR" as const };

    await expect(upsertAiBudget("ws-1", input)).rejects.toBeInstanceOf(AiBudgetLimitError);
    expect(aiBudget.create).not.toHaveBeenCalled();
  });

  it("deletes within the workspace only", async () => {
    aiBudget.deleteMany.mockResolvedValue({ count: 0 });
    expect(await deleteAiBudget("ws-other", "budget-1")).toBe(false);
    expect(aiBudget.deleteMany).toHaveBeenCalledWith({ where: { id: "budget-1", workspaceId: "ws-other" } });
  });
});
