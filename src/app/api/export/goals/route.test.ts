import Decimal from "decimal.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requireApiAccessMock = vi.fn();
const listGoalsMock = vi.fn();
const readAccountBalanceMock = vi.fn();
const sumGoalContributionsMock = vi.fn();
const recordAuditEventMock = vi.fn();

vi.mock("@/lib/auth/guard", () => ({
  requireApiAccess: (...args: unknown[]) => requireApiAccessMock(...args),
  moduleUnavailableResponse: () =>
    Response.json({ error: "not_found" }, { status: 404, headers: { "Cache-Control": "no-store" } }),
}));
vi.mock("@/modules/budget/repository", () => ({
  listGoals: (...args: unknown[]) => listGoalsMock(...args),
  readAccountBalance: (...args: unknown[]) => readAccountBalanceMock(...args),
  sumGoalContributions: (...args: unknown[]) => sumGoalContributionsMock(...args),
}));
vi.mock("@/modules/audit/repository", () => ({
  recordAuditEvent: (...args: unknown[]) => recordAuditEventMock(...args),
}));

const { GET } = await import("./route");

/**
 * Fictitious data only, with a frozen clock so the monthly contribution is exact.
 * What these tests pin down: session first, owner-scoped reads, a bounded read, the
 * status filter with its fallback, and the unknown-amount rule — an empty cell plus a
 * reason, never a zero.
 */
const OWNER = {
  id: "owner-1",
  email: "owner@example.test",
  name: null,
  workspace: { id: "ws-owner-1", role: "OWNER", modules: ["budget"] },
};

function goal(overrides: Record<string, unknown> = {}) {
  return {
    id: "goal-1",
    name: "Apport immobilier",
    targetAmount: new Decimal("1000"),
    currency: "EUR",
    // 2027-06 − 2026-10 = 8 whole months.
    targetDate: new Date(Date.UTC(2027, 5, 30)),
    status: "ACTIVE",
    currentAmount: new Decimal("300"),
    accountId: null,
    accountName: null,
    ...overrides,
  };
}

async function bodyOf(response: Response): Promise<string[]> {
  return (await response.text()).replace(/^\uFEFF/, "").split("\r\n");
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(Date.UTC(2026, 9, 6, 12, 0)));
  requireApiAccessMock.mockReset().mockResolvedValue(OWNER);
  listGoalsMock.mockReset().mockResolvedValue([goal()]);
  readAccountBalanceMock.mockReset().mockResolvedValue({
    transactionCount: 3,
    balance: new Decimal("250.00"),
  });
  // No logged contributions by default: the manual amount is the only source.
  sumGoalContributionsMock.mockReset().mockResolvedValue(new Map());
  recordAuditEventMock.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GET /api/export/goals", () => {
  it("refuses an unauthenticated request and reads nothing", async () => {
    requireApiAccessMock.mockResolvedValue(
      Response.json({ error: "authentication_required" }, { status: 401 }),
    );

    const response = await GET(new Request("http://test.local/api/export/goals"));

    expect(response.status).toBe(401);
    expect(listGoalsMock).not.toHaveBeenCalled();
  });

  it("answers 404 and reads nothing when the budget module is disabled", async () => {
    requireApiAccessMock.mockResolvedValue(Response.json({ error: "not_found" }, { status: 404 }));

    const response = await GET(new Request("http://test.local/api/export/goals"));

    expect(response.status).toBe(404);
    expect(listGoalsMock).not.toHaveBeenCalled();
  });

  it("exports a manual-amount goal with its progress, owner-scoped and bounded", async () => {
    const response = await GET(new Request("http://test.local/api/export/goals"));

    expect(response.status).toBe(200);
    expect(requireApiAccessMock).toHaveBeenCalledWith("export", "budget");
    expect(listGoalsMock).toHaveBeenCalledWith(OWNER.workspace.id, {
      status: undefined,
      from: undefined,
      to: undefined,
      take: 10_001,
    });
    expect(readAccountBalanceMock).not.toHaveBeenCalled();

    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Disposition")).toBe(
      'attachment; filename="objectifs.csv"',
    );

    const lines = await bodyOf(response);
    expect(lines[0]).toBe(
      "nom,devise,montant_cible,date_cible,statut,source_montant_actuel,compte,montant_actuel,progression_pourcent,reste,contribution_mensuelle,note",
    );
    expect(lines[1]).toBe(
      "Apport immobilier,EUR,1000.00,2027-06-30,ACTIVE,saisi,,300.00,30.0,700.00,87.50,",
    );
  });

  it("reads the linked account's balance for an account-sourced goal", async () => {
    listGoalsMock.mockResolvedValue([
      goal({ currentAmount: null, accountId: "account-1", accountName: "Compte courant" }),
    ]);

    const response = await GET(new Request("http://test.local/api/export/goals"));

    expect(readAccountBalanceMock).toHaveBeenCalledWith(OWNER.workspace.id, "account-1");

    const lines = await bodyOf(response);
    expect(lines[1]).toBe(
      "Apport immobilier,EUR,1000.00,2027-06-30,ACTIVE,compte,Compte courant,250.00,25.0,750.00,93.75,",
    );
  });

  it("adds logged contributions to a manual goal, exactly like the screen does", async () => {
    sumGoalContributionsMock.mockResolvedValue(
      new Map([["goal-1", { count: 2, total: new Decimal("150.00") }]]),
    );

    const lines = await bodyOf(await GET(new Request("http://test.local/api/export/goals")));

    // 300 (starting amount) + 150 (contributions) = 450 → 45 % of 1000.
    expect(lines[1]).toContain(",450.00,45.0,550.00,");
  });

  it("writes empty numeric cells and the reason for an unknown amount — never a zero", async () => {
    listGoalsMock.mockResolvedValue([goal({ currentAmount: null })]);

    const lines = await bodyOf(await GET(new Request("http://test.local/api/export/goals")));

    // Fields: nom, devise, montant_cible, date_cible, statut, source, compte, puis
    // montant_actuel, progression, reste, contribution laissés vides, et la raison.
    expect(lines[1]).toBe(
      'Apport immobilier,EUR,1000.00,2027-06-30,ACTIVE,aucune,,,,,,"Aucun montant actuel ni compte lié : la progression est inconnue, pas zéro."',
    );
    expect(lines[1]).toContain("inconnue, pas zéro");
    // No numeric cell invents a value.
    expect(lines[1]).not.toMatch(/,,0/);
    expect(lines[1]).not.toContain(",0.00,");
  });

  it("treats an account with no recorded transaction as unknown too", async () => {
    listGoalsMock.mockResolvedValue([
      goal({ currentAmount: null, accountId: "account-empty", accountName: "Livret vide" }),
    ]);
    readAccountBalanceMock.mockResolvedValue({
      transactionCount: 0,
      balance: new Decimal(0),
    });

    const lines = await bodyOf(await GET(new Request("http://test.local/api/export/goals")));

    expect(lines[1]).toContain("Aucune opération enregistrée sur le compte lié");
    expect(lines[1]).not.toMatch(/,0\.00,0\.0/);
  });

  it("forwards the status filter, and ignores an unknown one like the other exports", async () => {
    // Filtering happens in the read, not after it: a window cut before the filter would
    // report a completion the file does not have. The mock stands in for that read.
    listGoalsMock.mockResolvedValue([
      goal({ id: "goal-2", name: "Prêt auto", status: "ACHIEVED" }),
    ]);

    const filtered = await bodyOf(
      await GET(new Request("http://test.local/api/export/goals?status=ACHIEVED")),
    );
    expect(listGoalsMock).toHaveBeenLastCalledWith(OWNER.workspace.id, {
      status: "ACHIEVED",
      from: undefined,
      to: undefined,
      take: 10_001,
    });
    expect(filtered).toHaveLength(2);
    expect(filtered[1]).toContain("Prêt auto");

    await GET(new Request("http://test.local/api/export/goals?status=active"));
    expect(listGoalsMock).toHaveBeenLastCalledWith(OWNER.workspace.id, {
      status: undefined,
      from: undefined,
      to: undefined,
      take: 10_001,
    });
  });

  it("applies from/to to the target date, both days inclusive", async () => {
    const response = await GET(
      new Request("http://test.local/api/export/goals?from=2027-01-01&to=2027-12-31"),
    );

    expect(listGoalsMock).toHaveBeenLastCalledWith(OWNER.workspace.id, {
      status: undefined,
      from: new Date(Date.UTC(2027, 0, 1)),
      to: new Date(Date.UTC(2028, 0, 1)),
      take: 10_001,
    });
    expect(response.headers.get("Content-Disposition")).toBe(
      'attachment; filename="objectifs-2027-01-01_2027-12-31.csv"',
    );
  });

  it("reads one balance per distinct account, not one per goal", async () => {
    listGoalsMock.mockResolvedValue([
      goal({ id: "goal-1", currentAmount: null, accountId: "account-1" }),
      goal({ id: "goal-2", currentAmount: null, accountId: "account-1" }),
    ]);

    await GET(new Request("http://test.local/api/export/goals"));

    expect(readAccountBalanceMock).toHaveBeenCalledTimes(1);
  });

  it("records the export in the audit trail", async () => {
    await GET(new Request("http://test.local/api/export/goals?status=ACTIVE"));

    expect(recordAuditEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: OWNER.workspace.id,
        actorId: OWNER.id,
        action: "export.goals",
        entityType: "EXPORT",
        outcome: "SUCCESS",
        metadata: expect.objectContaining({ entity: "goals", scope: "all", rows: 1 }),
      }),
    );
  });

  it("writes a header line even without any goal", async () => {
    listGoalsMock.mockResolvedValue([]);

    const lines = await bodyOf(await GET(new Request("http://test.local/api/export/goals")));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("montant_cible");
  });

  it("neutralises a formula typed in a goal name", async () => {
    listGoalsMock.mockResolvedValue([goal({ name: "=HYPERLINK(\"http://x\")" })]);

    const body = await (await GET(new Request("http://test.local/api/export/goals"))).text();

    expect(body).toContain("'=HYPERLINK");
  });
});
