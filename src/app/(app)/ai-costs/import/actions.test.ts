import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CostImportSubmission } from "@/modules/ai-costs/import";

const requireModuleMock = vi.fn();
const auditMock = vi.fn();
const storedKeys = new Set<string>();
const createdInputs: unknown[] = [];
const saveMappingMock = vi.fn();
let failInsert = false;

vi.mock("@/lib/auth/guard", () => ({
  requireModule: (...args: unknown[]) => requireModuleMock(...args),
}));
vi.mock("@/modules/audit/repository", () => ({
  recordAuditEventSafely: (...args: unknown[]) => auditMock(...args),
}));
vi.mock("@/modules/ai-costs/repository", () => ({
  findExistingImportKeys: async (_workspaceId: string, keys: string[]) =>
    new Set(keys.filter((key) => storedKeys.has(key))),
  createImportedCostEntries: async (_workspaceId: string, rows: { input: unknown; importKey: string }[]) => {
    if (failInsert) throw new Error("db down");
    const created = new Set<string>();
    for (const row of rows) {
      if (!storedKeys.has(row.importKey)) {
        storedKeys.add(row.importKey);
        created.add(row.importKey);
        createdInputs.push(row.input);
      }
    }
    return created;
  },
  saveCostImportMapping: (...args: unknown[]) => saveMappingMock(...args),
}));

const { importCostsAction } = await import("./actions");

function sessionAs(role: string) {
  return { id: "user-1", workspace: { id: "ws-1", role, modules: ["ai-costs"] } };
}

const row = (line: number, overrides: Record<string, unknown> = {}) => ({
  line,
  date: "2026-03-01",
  periodEnd: null,
  label: `Ligne ${line}`,
  amount: "10.00",
  currency: "EUR",
  reference: null,
  notes: null,
  ...overrides,
});

function submission(overrides: Partial<CostImportSubmission> = {}): CostImportSubmission {
  return {
    source: "OpenAI factures",
    delimiter: ";",
    hasHeader: true,
    columns: { date: "Date", label: "Libellé", amount: "Montant" },
    defaultCurrency: "EUR",
    dryRun: false,
    rejectedInFile: 1,
    rows: [row(2, { reference: "INV-1" }), row(3, { amount: "-5.00" }), row(4)],
    ...overrides,
  };
}

beforeEach(() => {
  storedKeys.clear();
  createdInputs.length = 0;
  failInsert = false;
  vi.clearAllMocks();
  requireModuleMock.mockResolvedValue(sessionAs("OWNER"));
});

describe("importCostsAction", () => {
  it("creates the rows as observed import entries and audits counts only", async () => {
    const result = await importCostsAction(submission());

    expect(result).toMatchObject({
      status: "ok",
      dryRun: false,
      summary: { received: 3, created: 3, duplicates: 0, rejected: 0, rejectedInFile: 1 },
    });
    expect(createdInputs[1]).toMatchObject({
      amount: "-5.00",
      actuality: "observed",
      source: { kind: "import", rowNumber: 3 },
      periodStart: "2026-03-01",
      periodEnd: "2026-03-01",
      notes: "Ligne 3",
    });
    expect(saveMappingMock).toHaveBeenCalledWith("ws-1", expect.objectContaining({ source: "OpenAI factures" }));
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "cost.import",
        outcome: "SUCCESS",
        metadata: { received: 3, created: 3, duplicates: 0, rejected: 0, rejectedInFile: 1 },
      }),
    );
  });

  it("importing the same file twice creates nothing the second time", async () => {
    await importCostsAction(submission());
    const second = await importCostsAction(submission());

    expect(second).toMatchObject({ status: "ok", summary: { created: 0, duplicates: 3 } });
    expect(createdInputs).toHaveLength(3);
    if (second.status === "ok") {
      expect(second.outcomes[0].reason).toBe("Déjà importée : même source et même référence.");
      expect(second.outcomes[1].reason).toMatch(/même source, période/);
    }
  });

  it("a reference keeps a corrected label from becoming a new cost", async () => {
    await importCostsAction(submission());
    const corrected = await importCostsAction(
      submission({ rows: [row(2, { reference: "INV-1", label: "Libellé corrigé" })] }),
    );
    expect(corrected).toMatchObject({ summary: { created: 0, duplicates: 1 } });
  });

  it("reports identical lines of one file as duplicates, with the first line", async () => {
    const result = await importCostsAction(submission({ rows: [row(2), row(3, { label: "Ligne 2" })] }));

    expect(result).toMatchObject({ summary: { created: 1, duplicates: 1 } });
    if (result.status === "ok") {
      expect(result.outcomes[1]).toEqual({
        line: 3,
        status: "duplicate",
        reason: "Identique à la ligne 2 du fichier (sans référence).",
      });
    }
  });

  it("rejects a tampered row with its reason and keeps the others", async () => {
    const result = await importCostsAction(
      submission({ rows: [row(2, { amount: "1.999" }), row(3, { currency: "JPY" }), row(4)] }),
    );

    expect(result).toMatchObject({ summary: { created: 1, rejected: 2 } });
    if (result.status === "ok") {
      expect(result.outcomes.map((outcome) => outcome.reason)).toEqual([
        "Montant attendu au centime près.",
        "Devise non prise en charge.",
        null,
      ]);
    }
  });

  it("the preview classifies without writing, saving or auditing", async () => {
    storedKeys.add("unrelated");
    const result = await importCostsAction(submission({ dryRun: true }));

    expect(result).toMatchObject({ status: "ok", dryRun: true, summary: { importId: null, created: 0 } });
    if (result.status === "ok") {
      expect(result.outcomes.every((outcome) => outcome.status === "new")).toBe(true);
    }
    expect(createdInputs).toHaveLength(0);
    expect(saveMappingMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("refuses more rows than the bound", async () => {
    const rows = Array.from({ length: 2001 }, (_, index) => row(index + 2));
    const result = await importCostsAction(submission({ rows }));
    expect(result).toMatchObject({ status: "invalid" });
    expect(createdInputs).toHaveLength(0);
  });

  it("refuses a member and a viewer", async () => {
    requireModuleMock.mockResolvedValue(sessionAs("MEMBER"));
    expect(await importCostsAction(submission())).toMatchObject({ status: "error" });
    expect(createdInputs).toHaveLength(0);
  });

  it("audits a failed write without claiming success", async () => {
    failInsert = true;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await importCostsAction(submission());

    expect(result).toMatchObject({ status: "error" });
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ outcome: "FAILED" }));
  });
});
