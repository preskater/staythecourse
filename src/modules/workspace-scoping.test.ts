import Decimal from "decimal.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Workspace isolation (M7-04), one read and one write per module repository.
 *
 * The fake client answers like PostgreSQL would for a foreign workspace: no row, or a
 * write that matched nothing. Each test checks the workspace filter reaches the query
 * and that the repository reports "not found" rather than another workspace's row.
 */
const findFirstMock = vi.fn();
const findManyMock = vi.fn();
const updateManyMock = vi.fn();
const deleteManyMock = vi.fn();
const createMock = vi.fn();
const createValuationMock = vi.fn();
const table = {
  findFirst: findFirstMock,
  findMany: findManyMock,
  updateMany: updateManyMock,
  deleteMany: deleteManyMock,
  create: createMock,
};

const prisma = {
  account: table,
  exchangeRateSnapshot: table,
  property: table,
  propertyLoan: table,
  propertyValuation: { create: createValuationMock },
  alert: table,
  integrationConnection: table,
  issueSnapshot: table,
  // Interactive transactions hand the same fake client back to the callback.
  $transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback(prisma)),
};

vi.mock("@/lib/db", () => ({ getPrisma: () => prisma }));

const { createAccount, findAccount } = await import("./budget/repository");
const { deleteLoan, findProperty, updateProperty } = await import("./real-estate/repository");
const { dismissAlert, listAlerts } = await import("./alerts/repository");
const { findConnectionForSync, listIssues } = await import("./integrations/repository");
const { findExchangeRateSnapshotById, recordExchangeRate } = await import(
  "./ai-costs/repository"
);

const FOREIGN = "ws-someone-else";

beforeEach(() => {
  findFirstMock.mockReset().mockResolvedValue(null);
  findManyMock.mockReset().mockResolvedValue([]);
  updateManyMock.mockReset().mockResolvedValue({ count: 0 });
  deleteManyMock.mockReset().mockResolvedValue({ count: 0 });
  createMock.mockReset().mockResolvedValue({ id: "account-1" });
  createValuationMock.mockReset().mockResolvedValue({ id: "valuation-1" });
});

function where(mock: ReturnType<typeof vi.fn>) {
  return (mock.mock.calls[0][0] as { where: unknown }).where;
}

describe("budget", () => {
  it("reads a foreign workspace's account as not found", async () => {
    expect(await findAccount(FOREIGN, "account-1")).toBeNull();
    expect(where(findFirstMock)).toMatchObject({ id: "account-1", workspaceId: FOREIGN });
  });

  it("writes a new account into the given workspace only", async () => {
    await createAccount({
      workspaceId: "ws-1",
      name: " Courant ",
      type: "CHECKING",
      currency: "EUR",
      lowBalanceThreshold: null,
    });

    expect(createMock.mock.calls[0][0]).toMatchObject({ data: { workspaceId: "ws-1", name: "Courant" } });
  });
});

describe("real-estate", () => {
  it("reads a foreign workspace's property as not found", async () => {
    expect(await findProperty(FOREIGN, "property-1")).toBeNull();
    expect(where(findFirstMock)).toEqual({ id: "property-1", workspaceId: FOREIGN });
  });

  it("refuses to update or delete through a foreign workspace", async () => {
    const write = {
      name: "Appartement",
      address: null,
      occupancy: "VACANT",
      currency: "EUR",
      purchaseDate: null,
      purchasePrice: null,
      estimatedValue: new Decimal("250000.00"),
      estimatedValueAsOf: new Date("2026-01-01T00:00:00.000Z"),
      targetGainRate: new Decimal(10),
      notes: null,
    } as const;

    expect(await updateProperty(FOREIGN, "property-1", write)).toBe(false);
    expect(where(updateManyMock)).toEqual({ id: "property-1", workspaceId: FOREIGN });
    // A rejected update must not leave a valuation behind either.
    expect(createValuationMock).not.toHaveBeenCalled();

    expect(await deleteLoan(FOREIGN, "loan-1")).toBe(false);
    // A loan has no workspace column: the filter goes through its property.
    expect(where(deleteManyMock)).toEqual({ id: "loan-1", property: { workspaceId: FOREIGN } });
  });
});

describe("alerts", () => {
  it("lists only the workspace's alerts and cannot dismiss a foreign one", async () => {
    await listAlerts("ws-1");
    expect(where(findManyMock)).toEqual({ workspaceId: "ws-1" });

    expect(await dismissAlert(FOREIGN, "alert-1", new Date())).toBe(false);
    expect(where(updateManyMock)).toMatchObject({ id: "alert-1", workspaceId: FOREIGN });
  });
});

describe("integrations", () => {
  it("never decrypts a foreign workspace's connection", async () => {
    expect(await findConnectionForSync(FOREIGN, "connection-1")).toBeNull();
    expect(where(findFirstMock)).toEqual({ id: "connection-1", workspaceId: FOREIGN });
  });

  it("scopes snapshots through their connection", async () => {
    await listIssues("ws-1");
    expect(where(findManyMock)).toMatchObject({ connection: { workspaceId: "ws-1" } });
  });
});

describe("ai-costs", () => {
  it("reads a foreign workspace's exchange rate as not found", async () => {
    expect(await findExchangeRateSnapshotById(FOREIGN, "rate-1")).toBeNull();
    expect(where(findFirstMock)).toEqual({ id: "rate-1", workspaceId: FOREIGN });
  });

  it("writes a rate into the given workspace only", async () => {
    createMock.mockResolvedValueOnce({
      id: "rate-1",
      baseCurrency: "USD",
      quoteCurrency: "EUR",
      rate: new Decimal("0.92"),
      rateDate: new Date("2026-10-28T00:00:00.000Z"),
      source: { kind: "manual", enteredBy: "user-1", capturedAt: "2026-10-28T12:00:00.000Z" },
      recordedAt: new Date("2026-10-28T12:00:00.000Z"),
    });

    await recordExchangeRate({
      workspaceId: "ws-1",
      baseCurrency: "USD",
      quoteCurrency: "EUR",
      rate: "0.92",
      rateDate: "2026-10-28",
      source: { kind: "manual", enteredBy: "user-1" },
      recordedAt: "2026-10-28T12:00:00.000Z",
    });

    expect(createMock.mock.calls[0][0]).toMatchObject({
      data: { workspaceId: "ws-1", baseCurrency: "USD", quoteCurrency: "EUR" },
    });
  });
});
