import { beforeEach, describe, expect, it, vi } from "vitest";
import { passwordTag } from "@/lib/auth/password";
import type { WorkspaceRole } from "@/modules/identity/workspace";

const authMock = vi.fn();
const findActiveSessionMock = vi.fn();
const touchSessionMock = vi.fn();
const findOwnerByIdMock = vi.fn();
const listMembershipsMock = vi.fn();

vi.mock("@/auth", () => ({ auth: () => authMock() }));
vi.mock("@/modules/identity/sessions", () => ({
  findActiveSession: (...args: unknown[]) => findActiveSessionMock(...args),
  touchSession: (...args: unknown[]) => touchSessionMock(...args),
}));
vi.mock("@/modules/identity/repository", () => ({
  findOwnerById: (...args: unknown[]) => findOwnerByIdMock(...args),
  listMemberships: (...args: unknown[]) => listMembershipsMock(...args),
}));

const listAlertsMock = vi.fn();
const listBudgetsMock = vi.fn();
const listBudgetsInRangeMock = vi.fn();
const listGoalsMock = vi.fn();
const readAccountBalanceMock = vi.fn();
const sumGoalContributionsMock = vi.fn();
const listTransactionsMock = vi.fn();
const listPropertiesMock = vi.fn();
const recordAuditEventMock = vi.fn();

vi.mock("@/modules/alerts/repository", () => ({
  listAlerts: (...args: unknown[]) => listAlertsMock(...args),
}));
vi.mock("@/modules/budget/repository", () => ({
  listBudgets: (...args: unknown[]) => listBudgetsMock(...args),
  listBudgetsInRange: (...args: unknown[]) => listBudgetsInRangeMock(...args),
  listGoals: (...args: unknown[]) => listGoalsMock(...args),
  readAccountBalance: (...args: unknown[]) => readAccountBalanceMock(...args),
  sumGoalContributions: (...args: unknown[]) => sumGoalContributionsMock(...args),
  listTransactions: (...args: unknown[]) => listTransactionsMock(...args),
}));
vi.mock("@/modules/real-estate/repository", () => ({
  listProperties: (...args: unknown[]) => listPropertiesMock(...args),
}));
vi.mock("@/modules/audit/repository", () => ({
  recordAuditEvent: (...args: unknown[]) => recordAuditEventMock(...args),
}));

const alertsRoute = await import("./alerts/route");
const budgetsRoute = await import("./budgets/route");
const goalsRoute = await import("./goals/route");
const propertiesRoute = await import("./properties/route");
const transactionsRoute = await import("./transactions/route");

/**
 * Route × role matrix for the CSV exports, driven through the real guard.
 *
 * Only the identity lookups and the data reads are mocked: the session resolution,
 * workspace resolution, permission matrix and 401/403 bodies are the production code.
 * A viewer may read the workspace but may never take personal data out of it.
 */

const owner = {
  id: "user-1",
  email: "owner@example.test",
  name: null,
  passwordHash: "$2b$12$matrix-test-hash",
};

const sessionRecord = {
  id: "session-1",
  lastSeenAt: new Date(),
  user: owner,
};

const validToken = {
  user: { id: owner.id, email: owner.email, name: owner.name },
  passwordTag: passwordTag(owner.passwordHash),
  sessionId: sessionRecord.id,
};

function membership(role: WorkspaceRole) {
  return {
    id: "ws-1",
    name: "Espace",
    kind: "PERSONAL",
    role,
    modules: ["budget", "real-estate", "development"],
  };
}

const ROUTES = [
  {
    name: "alerts",
    url: "http://test.local/api/export/alerts",
    get: alertsRoute.GET,
    reads: [listAlertsMock],
  },
  {
    name: "budgets",
    url: "http://test.local/api/export/budgets",
    get: budgetsRoute.GET,
    reads: [listBudgetsMock],
  },
  {
    name: "goals",
    url: "http://test.local/api/export/goals",
    get: goalsRoute.GET,
    reads: [listGoalsMock, readAccountBalanceMock, sumGoalContributionsMock],
  },
  {
    name: "properties",
    url: "http://test.local/api/export/properties",
    get: propertiesRoute.GET,
    reads: [listPropertiesMock],
  },
  {
    name: "transactions",
    url: "http://test.local/api/export/transactions",
    get: transactionsRoute.GET,
    reads: [listTransactionsMock],
  },
];

beforeEach(() => {
  authMock.mockReset().mockResolvedValue(validToken);
  findActiveSessionMock.mockReset().mockResolvedValue(sessionRecord);
  touchSessionMock.mockReset().mockResolvedValue(undefined);
  findOwnerByIdMock.mockReset().mockResolvedValue(owner);
  listMembershipsMock.mockReset().mockResolvedValue([membership("OWNER")]);

  for (const mock of [
    listAlertsMock,
    listBudgetsMock,
    listBudgetsInRangeMock,
    listGoalsMock,
    readAccountBalanceMock,
    sumGoalContributionsMock,
    listTransactionsMock,
    listPropertiesMock,
    recordAuditEventMock,
  ]) {
    mock.mockReset().mockResolvedValue([]);
  }

  recordAuditEventMock.mockResolvedValue(undefined);
});

describe.each(ROUTES)("GET /api/export/$name", (route) => {
  it("refuses an anonymous request with 401 JSON before reading a row", async () => {
    authMock.mockResolvedValue(null);

    const response = await route.get(new Request(route.url));

    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "authentication_required" });
    for (const read of route.reads) {
      expect(read).not.toHaveBeenCalled();
    }
  });

  it.each(["OWNER", "ADMIN", "MEMBER"] as WorkspaceRole[])(
    "lets a %s export",
    async (role) => {
      listMembershipsMock.mockResolvedValue([membership(role)]);

      const response = await route.get(new Request(route.url));

      expect(response.status).toBe(200);
    },
  );

  it("refuses a viewer with 403 JSON and reads nothing", async () => {
    listMembershipsMock.mockResolvedValue([membership("VIEWER")]);

    const response = await route.get(new Request(route.url));

    expect(response.status).toBe(403);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "forbidden" });
    for (const read of route.reads) {
      expect(read).not.toHaveBeenCalled();
    }
  });
});

describe("module gate", () => {
  it("keeps answering 404 for a disabled budget module, even to a viewer", async () => {
    listMembershipsMock.mockResolvedValue([
      { ...membership("VIEWER"), modules: ["real-estate"] },
    ]);

    const response = await budgetsRoute.GET(
      new Request("http://test.local/api/export/budgets"),
    );

    expect(response.status).toBe(404);
    expect(listBudgetsMock).not.toHaveBeenCalled();
  });

  it("keeps answering 404 for a disabled real-estate module", async () => {
    listMembershipsMock.mockResolvedValue([
      { ...membership("OWNER"), modules: ["budget"] },
    ]);

    const response = await propertiesRoute.GET(
      new Request("http://test.local/api/export/properties"),
    );

    expect(response.status).toBe(404);
    expect(listPropertiesMock).not.toHaveBeenCalled();
  });
});
