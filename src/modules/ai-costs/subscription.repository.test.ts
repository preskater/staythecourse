import Decimal from "decimal.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseDateOnly, toDateOnlyString } from "@/lib/dates";

const aiSubscription = { findMany: vi.fn(), findFirst: vi.fn(), count: vi.fn(), create: vi.fn(), updateMany: vi.fn() };
const aiSubscriptionRenewal = { findMany: vi.fn(), create: vi.fn() };
const costEntry = { create: vi.fn(), aggregate: vi.fn(), groupBy: vi.fn() };
const tx = { costEntry, aiSubscriptionRenewal };
const findPolicy = vi.fn();
const applyPolicy = vi.fn();

vi.mock("@/lib/db", () => ({
  getPrisma: () => ({
    aiSubscription,
    aiSubscriptionRenewal,
    costEntry,
    $transaction: (work: (client: typeof tx) => unknown) => work(tx),
  }),
}));
vi.mock("./policy.repository", () => ({
  findAllocationPolicy: (...args: unknown[]) => findPolicy(...args),
  applyAllocationPolicy: (...args: unknown[]) => applyPolicy(...args),
}));

const {
  bookDueRenewals,
  cancelAiSubscription,
  createAiSubscription,
  InvalidSubscriptionError,
  readCoreFormula,
  readSubscriptionMetered,
} = await import("./subscription.repository");

/** Fictitious subscription row, as Prisma returns it. */
function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "sub-1",
    provider: "openai",
    plan: "Team",
    seats: 2,
    seatPrice: new Decimal("20.00"),
    currency: "EUR",
    frequency: "MONTHLY",
    startDate: parseDateOnly("2026-10-05"),
    cancelledOn: null,
    allowance: null,
    ownerId: "dev-1",
    allocationPolicyId: null,
    createdBy: "user-1",
    notes: null,
    _count: { renewals: 0 },
    ...overrides,
  };
}

const TODAY = parseDateOnly("2026-11-19");
let entrySequence = 0;

beforeEach(() => {
  for (const group of [aiSubscription, aiSubscriptionRenewal, costEntry]) {
    for (const mock of Object.values(group)) mock.mockReset();
  }
  findPolicy.mockReset();
  applyPolicy.mockReset().mockResolvedValue({});
  entrySequence = 0;
  costEntry.create.mockImplementation(async () => ({ id: `entry-${++entrySequence}` }));
  aiSubscriptionRenewal.create.mockResolvedValue({});
  aiSubscriptionRenewal.findMany.mockResolvedValue([]);
});

describe("bookDueRenewals", () => {
  it("books each due renewal once as a DERIVED, tagged entry covering the paid period", async () => {
    aiSubscription.findMany.mockResolvedValue([row()]);

    expect(await bookDueRenewals("ws-1", TODAY)).toBe(2);

    expect(aiSubscription.findMany.mock.calls[0][0].where).toEqual({ workspaceId: "ws-1" });
    const [first] = costEntry.create.mock.calls.map(([args]) => args.data);
    expect(first).toMatchObject({
      workspaceId: "ws-1",
      amount: "40.00",
      currency: "EUR",
      actuality: "DERIVED",
      sourceKind: "MANUAL",
      sourceEnteredBy: "user-1",
      developerId: "dev-1",
      tags: ["subscription"],
    });
    expect(toDateOnlyString(first.periodStart)).toBe("2026-10-05");
    expect(toDateOnlyString(first.periodEnd)).toBe("2026-11-04");
    expect(aiSubscriptionRenewal.create.mock.calls[0][0].data).toMatchObject({
      subscriptionId: "sub-1",
      costEntryId: "entry-1",
    });
  });

  it("is re-runnable: a booked renewal is skipped, and a concurrent duplicate is ignored", async () => {
    aiSubscription.findMany.mockResolvedValue([row()]);
    aiSubscriptionRenewal.findMany.mockResolvedValue([{ renewalDate: parseDateOnly("2026-10-05") }]);
    aiSubscriptionRenewal.create.mockRejectedValueOnce(Object.assign(new Error("unique"), { code: "P2002" }));

    expect(await bookDueRenewals("ws-1", TODAY)).toBe(0);
    expect(costEntry.create).toHaveBeenCalledTimes(1);
    expect(aiSubscriptionRenewal.findMany.mock.calls[0][0].where).toMatchObject({ subscription: { workspaceId: "ws-1" } });
  });

  it("splits each renewal with the policy, one seat per target, and survives a failed split", async () => {
    aiSubscription.findMany.mockResolvedValue([row({ allocationPolicyId: "policy-1" })]);
    findPolicy.mockResolvedValue({ kind: "EQUAL_SEAT", archivedAt: null, latestVersion: { targets: [{}, {}] } });
    applyPolicy.mockRejectedValueOnce(new Error("no weight"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await bookDueRenewals("ws-1", TODAY)).toBe(2);

    expect(applyPolicy).toHaveBeenCalledTimes(2);
    expect(applyPolicy.mock.calls[1]).toEqual([
      "ws-1",
      { entryId: "entry-2", policyId: "policy-1", measures: [new Decimal(1), new Decimal(1)] },
    ]);
    consoleError.mockRestore();
  });

  it("books nothing for a subscription cancelled before its first renewal", async () => {
    aiSubscription.findMany.mockResolvedValue([row({ cancelledOn: parseDateOnly("2026-10-05") })]);
    expect(await bookDueRenewals("ws-1", TODAY)).toBe(0);
    expect(costEntry.create).not.toHaveBeenCalled();
  });
});

describe("register writes", () => {
  const input = {
    provider: "openai",
    plan: "Team",
    seats: 2,
    seatPrice: new Decimal("20"),
    currency: "EUR" as const,
    frequency: "MONTHLY" as const,
    startDate: parseDateOnly("2026-11-01"),
    allowance: null,
    ownerId: null,
    allocationPolicyId: "policy-1",
    notes: null,
  };

  it("refuses a policy that needs typed measures, or one from another workspace", async () => {
    findPolicy.mockResolvedValueOnce({ kind: "USAGE_WEIGHTED", archivedAt: null });
    await expect(createAiSubscription("ws-1", "user-1", input)).rejects.toBeInstanceOf(InvalidSubscriptionError);

    findPolicy.mockResolvedValueOnce(null);
    await expect(createAiSubscription("ws-1", "user-1", input)).rejects.toBeInstanceOf(InvalidSubscriptionError);
    expect(findPolicy).toHaveBeenLastCalledWith("ws-1", "policy-1");
    expect(aiSubscription.create).not.toHaveBeenCalled();
  });

  it("creates in the workspace, exact amounts as strings", async () => {
    findPolicy.mockResolvedValue({ kind: "FIXED_PERCENTAGE", archivedAt: null });
    aiSubscription.count.mockResolvedValue(0);
    aiSubscription.create.mockResolvedValue({ id: "sub-9" });

    expect(await createAiSubscription("ws-1", "user-1", input)).toEqual({ id: "sub-9" });
    expect(aiSubscription.create.mock.calls[0][0].data).toMatchObject({ workspaceId: "ws-1", seatPrice: "20.00", createdBy: "user-1" });
  });

  it("cancels once, never before the start, and keeps the row", async () => {
    aiSubscription.findFirst.mockResolvedValue({ startDate: parseDateOnly("2026-10-05") });
    aiSubscription.updateMany.mockResolvedValue({ count: 1 });

    await expect(cancelAiSubscription("ws-1", "sub-1", parseDateOnly("2026-10-01"))).rejects.toBeInstanceOf(
      InvalidSubscriptionError,
    );
    expect(await cancelAiSubscription("ws-1", "sub-1", parseDateOnly("2026-12-01"))).toBe(true);
    expect(aiSubscription.updateMany.mock.calls[0][0]).toEqual({
      where: { id: "sub-1", workspaceId: "ws-1", cancelledOn: null },
      data: { cancelledOn: parseDateOnly("2026-12-01") },
    });

    aiSubscription.findFirst.mockResolvedValue(null);
    expect(await cancelAiSubscription("ws-other", "sub-1", TODAY)).toBe(false);
  });
});

describe("readers", () => {
  it("measures the allowance on metered entries of the provider only, and reads no entry as no data", async () => {
    costEntry.aggregate
      .mockResolvedValueOnce({ _sum: { amount: new Decimal("12.5") }, _count: { _all: 3 } })
      .mockResolvedValueOnce({ _sum: { amount: null }, _count: { _all: 0 } });
    const subscriptions = [
      { ...row({ allowance: new Decimal(50) }), seatPrice: new Decimal(20), allowance: new Decimal(50) },
      { ...row({ id: "sub-2" }), seatPrice: new Decimal(20), allowance: new Decimal(10) },
    ] as never;

    const metered = await readSubscriptionMetered("ws-1", subscriptions, TODAY);

    expect(metered.get("sub-1")?.toFixed(2)).toBe("12.50");
    expect(metered.get("sub-2")).toBeNull();
    expect(costEntry.aggregate.mock.calls[0][0].where).toMatchObject({
      workspaceId: "ws-1",
      sourceProvider: "openai",
      currency: "EUR",
      NOT: { tags: { has: "subscription" } },
    });
  });

  it("splits the month into metered usage and subscriptions, per currency", async () => {
    costEntry.groupBy
      .mockResolvedValueOnce([{ currency: "EUR", _sum: { amount: new Decimal("40") }, _count: { _all: 1 } }])
      .mockResolvedValueOnce([
        { currency: "EUR", _sum: { amount: new Decimal("12.30") }, _count: { _all: 4 } },
        { currency: "USD", _sum: { amount: new Decimal("5") }, _count: { _all: 1 } },
      ]);

    const rows = await readCoreFormula("ws-1", parseDateOnly("2026-11-01"), parseDateOnly("2026-12-01"));

    expect(rows.map((item) => [item.currency, item.metered.toFixed(2), item.subscriptions.toFixed(2), item.entryCount])).toEqual([
      ["EUR", "12.30", "40.00", 5],
      ["USD", "5.00", "0.00", 1],
    ]);
    for (const [args] of costEntry.groupBy.mock.calls) expect(args.where.workspaceId).toBe("ws-1");
  });
});
