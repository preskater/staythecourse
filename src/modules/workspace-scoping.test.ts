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
  property: table,
  propertyLoan: table,
  propertyValuation: { create: createValuationMock },
  client: table,
  project: table,
  alert: table,
  integrationConnection: table,
  issueSnapshot: table,
  // Interactive transactions hand the same fake client back to the callback.
  $transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback(prisma)),
};

vi.mock("@/lib/db", () => ({ getPrisma: () => prisma }));

const { createAccount, findAccount } = await import("./budget/repository");
const { deleteLoan, findProperty, updateProperty } = await import("./real-estate/repository");
const {
  createClient,
  createProject,
  findClient,
  findProject,
  listClients,
  listProjects,
  setClientArchived,
  updateProject,
} = await import("./micro-business/repository");
const { dismissAlert, listAlerts } = await import("./alerts/repository");
const { findConnectionForSync, listIssues } = await import("./integrations/repository");

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

/** The filter of the most recent query, for tests that issue more than one. */
function lastWhere(mock: ReturnType<typeof vi.fn>) {
  return (mock.mock.calls.at(-1)?.[0] as { where: unknown }).where;
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

describe("micro-business", () => {
  const projectWrite = {
    name: "Refonte",
    clientId: null,
    billingModel: "INTERNAL",
    status: "ACTIVE",
    currency: "EUR",
    startDate: null,
    endDate: null,
    notes: null,
  } as const;

  it("lists only the workspace's clients and projects", async () => {
    await listClients("ws-1");
    expect(where(findManyMock)).toEqual({ workspaceId: "ws-1" });

    await listProjects("ws-1");
    expect(where(findManyMock)).toEqual({ workspaceId: "ws-1" });
  });

  it("reads a foreign workspace's client or project as not found", async () => {
    expect(await findClient(FOREIGN, "client-1")).toBeNull();
    expect(where(findFirstMock)).toEqual({ id: "client-1", workspaceId: FOREIGN });

    expect(await findProject(FOREIGN, "project-1")).toBeNull();
    expect(lastWhere(findFirstMock)).toEqual({ id: "project-1", workspaceId: FOREIGN });
  });

  it("writes a client into the given workspace only", async () => {
    await createClient({
      workspaceId: "ws-1",
      name: " Studio ",
      contactName: null,
      email: null,
      notes: null,
    });

    expect(createMock.mock.calls[0][0]).toMatchObject({
      data: { workspaceId: "ws-1", name: "Studio" },
    });
  });

  it("refuses to archive a foreign client", async () => {
    expect(await setClientArchived(FOREIGN, "client-1", true)).toBe(false);
    expect(where(updateManyMock)).toEqual({ id: "client-1", workspaceId: FOREIGN });
  });

  it("never links a project to a client from another workspace", async () => {
    // The fake client answers like PostgreSQL: no client row in this workspace.
    expect(await createProject({ workspaceId: "ws-1", ...projectWrite, clientId: "client-foreign" })).toBeNull();
    expect(where(findFirstMock)).toEqual({ id: "client-foreign", workspaceId: "ws-1" });
    expect(createMock).not.toHaveBeenCalled();

    expect(await updateProject(FOREIGN, "project-1", { ...projectWrite, clientId: "client-foreign" })).toBe(false);
    expect(lastWhere(findFirstMock)).toEqual({ id: "client-foreign", workspaceId: FOREIGN });
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("scopes a project write by the workspace, archived state included", async () => {
    expect(await updateProject(FOREIGN, "project-1", projectWrite)).toBe(false);
    expect(where(updateManyMock)).toEqual({ id: "project-1", workspaceId: FOREIGN });
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
