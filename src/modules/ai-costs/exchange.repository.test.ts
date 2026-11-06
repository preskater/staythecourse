import Decimal from "decimal.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Exchange-rate persistence (M9-04).
 *
 * The fake client answers like PostgreSQL would. Each test checks that the workspace
 * filter reaches the query, that a rate is written exactly, and that the "latest
 * snapshot on or before a day" rule is part of the query rather than a sorted read in
 * memory — loading a whole rate history to pick one row is how an old rate gets used.
 */
const createMock = vi.fn();
const findFirstMock = vi.fn();
const findManyMock = vi.fn();

const prisma = {
  exchangeRateSnapshot: {
    create: createMock,
    findFirst: findFirstMock,
    findMany: findManyMock,
  },
};

vi.mock("@/lib/db", () => ({ getPrisma: () => prisma }));

const {
  findExchangeRateSnapshot,
  findExchangeRateSnapshotById,
  listExchangeRates,
  recordExchangeRate,
} = await import("./repository");
const { InvalidExchangeRateError } = await import("./exchange");
const { createCostSource } = await import("./source");

const RECORDED_AT = new Date("2026-10-28T12:00:00.000Z");

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "rate-1",
    baseCurrency: "USD",
    quoteCurrency: "EUR",
    rate: new Decimal("0.92"),
    rateDate: new Date("2026-10-28T00:00:00.000Z"),
    source: {
      kind: "manual",
      enteredBy: "user-1",
      capturedAt: RECORDED_AT.toISOString(),
    },
    recordedAt: RECORDED_AT,
    ...overrides,
  };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: "ws-1",
    baseCurrency: "USD",
    quoteCurrency: "EUR",
    rate: "0.92",
    rateDate: "2026-10-28",
    source: createCostSource({
      kind: "manual",
      enteredBy: "user-1",
      capturedAt: RECORDED_AT,
    }),
    recordedAt: RECORDED_AT,
    ...overrides,
  } as Parameters<typeof recordExchangeRate>[0];
}

type QueryArgs = {
  where: Record<string, unknown>;
  orderBy?: Record<string, string>[];
  take?: number;
};

function firstArg(mock: ReturnType<typeof vi.fn>): QueryArgs {
  return mock.mock.calls[0][0] as QueryArgs;
}

beforeEach(() => {
  createMock.mockReset().mockResolvedValue(row());
  findFirstMock.mockReset().mockResolvedValue(null);
  findManyMock.mockReset().mockResolvedValue([]);
});

describe("recordExchangeRate", () => {
  it("writes the rate exactly, in the workspace, with its frozen source", async () => {
    const snapshot = await recordExchangeRate(input({ rate: "0.9145378931" }));

    expect(createMock.mock.calls[0][0]).toMatchObject({
      data: {
        workspaceId: "ws-1",
        baseCurrency: "USD",
        quoteCurrency: "EUR",
        rate: "0.9145378931",
        rateDate: new Date("2026-10-28T00:00:00.000Z"),
        source: {
          kind: "manual",
          enteredBy: "user-1",
          capturedAt: RECORDED_AT.toISOString(),
        },
        recordedAt: RECORDED_AT,
      },
    });
    expect(snapshot.rate.toFixed(10)).toBe("0.9200000000");
    expect(snapshot.id).toBe("rate-1");
  });

  it("refuses an invalid rate before writing anything", async () => {
    await expect(recordExchangeRate(input({ rate: "0" }))).rejects.toThrow(
      InvalidExchangeRateError,
    );
    expect(createMock).not.toHaveBeenCalled();
  });

  it("refuses a missing workspace", async () => {
    await expect(recordExchangeRate(input({ workspaceId: " " }))).rejects.toThrow(
      /workspaceId/,
    );
    expect(createMock).not.toHaveBeenCalled();
  });

  it("re-validates the stored row instead of trusting it", async () => {
    createMock.mockResolvedValueOnce(row({ rate: new Decimal(0) }));

    await expect(recordExchangeRate(input())).rejects.toThrow(
      InvalidExchangeRateError,
    );
  });
});

describe("findExchangeRateSnapshotById", () => {
  it("scopes the read to the workspace", async () => {
    expect(await findExchangeRateSnapshotById("ws-1", "rate-1")).toBeNull();
    expect(firstArg(findFirstMock).where).toEqual({
      id: "rate-1",
      workspaceId: "ws-1",
    });
  });

  it("maps a stored row to a snapshot", async () => {
    findFirstMock.mockResolvedValueOnce(row());

    const snapshot = await findExchangeRateSnapshotById("ws-1", "rate-1");

    expect(snapshot?.rate.toFixed(10)).toBe("0.9200000000");
    expect(snapshot?.source).toMatchObject({ kind: "manual" });
  });
});

describe("findExchangeRateSnapshot", () => {
  it("takes the latest snapshot of the pair on or before the requested day", async () => {
    findFirstMock.mockResolvedValueOnce(row());

    await findExchangeRateSnapshot("ws-1", {
      baseCurrency: "USD",
      quoteCurrency: "EUR",
      asOf: "2026-10-30",
    });

    const args = firstArg(findFirstMock);
    expect(args.where).toEqual({
      workspaceId: "ws-1",
      baseCurrency: "USD",
      quoteCurrency: "EUR",
      rateDate: { lte: new Date("2026-10-30T00:00:00.000Z") },
    });
    // A deterministic tie-break: same-day corrections, then two rows in one ms.
    expect(args.orderBy).toEqual([
      { rateDate: "desc" },
      { recordedAt: "desc" },
      { id: "desc" },
    ]);
  });

  it("has no upper bound when no day is given", async () => {
    await findExchangeRateSnapshot("ws-1", {
      baseCurrency: "USD",
      quoteCurrency: "EUR",
    });

    expect(firstArg(findFirstMock).where).not.toHaveProperty("rateDate");
  });

  it("reads a Date as its UTC calendar day", async () => {
    await findExchangeRateSnapshot("ws-1", {
      baseCurrency: "USD",
      quoteCurrency: "EUR",
      asOf: new Date("2026-10-29T23:30:00.000Z"),
    });

    expect(firstArg(findFirstMock).where.rateDate).toEqual({
      lte: new Date("2026-10-29T00:00:00.000Z"),
    });
  });

  it("refuses an identity pair instead of guessing a rate", async () => {
    await expect(
      findExchangeRateSnapshot("ws-1", {
        baseCurrency: "EUR",
        quoteCurrency: "EUR",
      }),
    ).rejects.toThrow(InvalidExchangeRateError);
    expect(findFirstMock).not.toHaveBeenCalled();
  });

  it("returns null when the pair has never been recorded", async () => {
    expect(
      await findExchangeRateSnapshot("ws-1", {
        baseCurrency: "USD",
        quoteCurrency: "EUR",
        asOf: "2026-10-28",
      }),
    ).toBeNull();
  });
});

describe("listExchangeRates", () => {
  it("lists the workspace's snapshots, newest first", async () => {
    findManyMock.mockResolvedValueOnce([row()]);

    const rates = await listExchangeRates("ws-1");

    expect(rates).toHaveLength(1);
    expect(firstArg(findManyMock)).toMatchObject({
      where: { workspaceId: "ws-1" },
      take: 100,
    });
    expect(firstArg(findManyMock).orderBy?.[0]).toEqual({ rateDate: "desc" });
  });

  it("filters on one pair and bounds the page size", async () => {
    await listExchangeRates("ws-1", {
      pair: { baseCurrency: "USD", quoteCurrency: "EUR" },
      take: 5000,
    });

    expect(firstArg(findManyMock).where).toEqual({
      workspaceId: "ws-1",
      baseCurrency: "USD",
      quoteCurrency: "EUR",
    });
    expect(firstArg(findManyMock).take).toBe(500);
  });

  it("never returns an empty page for a zero size", async () => {
    await listExchangeRates("ws-1", { take: 0 });

    expect(firstArg(findManyMock).take).toBe(1);
  });
});
