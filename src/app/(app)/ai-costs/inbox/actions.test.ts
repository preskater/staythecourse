import { beforeEach, describe, expect, it, vi } from "vitest";
import { FinalizedCostEntryError } from "@/modules/ai-costs/ledger";
import { InvalidAllocationPolicyError } from "@/modules/ai-costs/policy";

const requireModuleMock = vi.fn();
const auditMock = vi.fn();
const applyMock = vi.fn();
const findPolicyMock = vi.fn();
const finalizeMock = vi.fn();

vi.mock("@/lib/auth/guard", () => ({ requireModule: (...args: unknown[]) => requireModuleMock(...args) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/modules/audit/repository", () => ({ recordAuditEventSafely: (...args: unknown[]) => auditMock(...args) }));
vi.mock("@/modules/ai-costs/policy.repository", () => ({
  applyAllocationPolicy: (...args: unknown[]) => applyMock(...args),
  findAllocationPolicy: (...args: unknown[]) => findPolicyMock(...args),
}));
vi.mock("@/modules/ai-costs/repository", () => ({ finalizeCostEntry: (...args: unknown[]) => finalizeMock(...args) }));

const { applyPolicyToEntriesAction, finalizeEntriesAction } = await import("./actions");

function sessionAs(role: string) {
  return { id: "user-1", workspace: { id: "ws-1", role, modules: ["ai-costs"] } };
}

const policy = { id: "policy-1", name: "50/50", kind: "FIXED_PERCENTAGE", archivedAt: null, latestVersion: { id: "version-3", version: 3 } };

beforeEach(() => {
  vi.clearAllMocks();
  requireModuleMock.mockResolvedValue(sessionAs("OWNER"));
  findPolicyMock.mockResolvedValue(policy);
  applyMock.mockImplementation(async (_workspaceId: string, input: { entryId: string }) => {
    if (input.entryId === "done") throw new InvalidAllocationPolicyError("amount", "nothing left to allocate");
    if (input.entryId === "locked") throw new FinalizedCostEntryError();
    return {
      policyVersionId: "version-3",
      version: 3,
      created: 2,
      planned: [
        { dimensions: { projectId: "p-a" }, amount: "50.00", measure: "50" },
        { dimensions: { projectId: "p-b" }, amount: "50.00", measure: "50" },
      ],
    };
  });
});

describe("applyPolicyToEntriesAction", () => {
  it("applies entry by entry, reports each refusal and audits the actor with counts", async () => {
    const result = await applyPolicyToEntriesAction({
      entryIds: ["a", "done", "locked"],
      policyId: "policy-1",
      measures: null,
      dryRun: false,
    });

    expect(result).toMatchObject({ status: "ok" });
    if (result.status !== "ok") return;
    expect(result.outcomes.map((outcome) => [outcome.entryId, outcome.ok])).toEqual([
      ["a", true],
      ["done", false],
      ["locked", false],
    ]);
    expect(result.outcomes[1].reason).toMatch(/déjà entièrement réparti/);
    expect(result.outcomes[2].reason).toMatch(/déjà validé/);
    expect(result.outcomes[0].planned[0]).toEqual({ dimensions: "Projet p-a", amount: "50.00", measure: "50" });
    expect(applyMock).toHaveBeenCalledWith("ws-1", expect.objectContaining({ entryId: "a", dryRun: false }));
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-1",
        actorId: "user-1",
        action: "cost.allocate",
        entityId: "version-3",
        outcome: "SUCCESS",
        metadata: { policyKind: "FIXED_PERCENTAGE", policyVersion: 3, requested: 3, allocated: 1, refused: 2 },
      }),
    );
  });

  it("the preview writes nothing and is not audited", async () => {
    const result = await applyPolicyToEntriesAction({ entryIds: ["a"], policyId: "policy-1", measures: null, dryRun: true });

    expect(result).toMatchObject({ status: "ok" });
    expect(applyMock).toHaveBeenCalledWith("ws-1", expect.objectContaining({ dryRun: true }));
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("refuses an unknown or archived policy and more than the bound", async () => {
    findPolicyMock.mockResolvedValueOnce(null);
    expect(await applyPolicyToEntriesAction({ entryIds: ["a"], policyId: "x", measures: null, dryRun: true })).toMatchObject({
      status: "invalid",
    });
    findPolicyMock.mockResolvedValueOnce({ ...policy, archivedAt: new Date() });
    expect(await applyPolicyToEntriesAction({ entryIds: ["a"], policyId: "x", measures: null, dryRun: true })).toMatchObject({
      status: "invalid",
    });
    const tooMany = Array.from({ length: 51 }, (_, index) => `e${index}`);
    expect(await applyPolicyToEntriesAction({ entryIds: tooMany, policyId: "policy-1", measures: null, dryRun: true })).toMatchObject({
      status: "invalid",
    });
    expect(applyMock).not.toHaveBeenCalled();
  });

  it.each(["VIEWER", "MEMBER"])("refuses a %s", async (role) => {
    requireModuleMock.mockResolvedValue(sessionAs(role));
    const result = await applyPolicyToEntriesAction({ entryIds: ["a"], policyId: "policy-1", measures: null, dryRun: false });

    expect(result).toMatchObject({ status: "error" });
    expect(applyMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });
});

describe("finalizeEntriesAction", () => {
  it("finalizes each entry, reports the missing one and audits counts", async () => {
    finalizeMock.mockImplementation(async (_workspaceId: string, entryId: string) => entryId !== "foreign");

    const result = await finalizeEntriesAction({ entryIds: ["a", "foreign"] });

    expect(result).toMatchObject({ status: "ok" });
    if (result.status !== "ok") return;
    expect(result.outcomes.map((outcome) => outcome.ok)).toEqual([true, false]);
    expect(result.outcomes[1].reason).toBe("Coût introuvable dans cet espace.");
    expect(finalizeMock).toHaveBeenCalledWith("ws-1", "a");
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: "user-1",
        action: "cost.finalize",
        metadata: { requested: 2, finalized: 1, refused: 1 },
      }),
    );
  });

  it("refuses a viewer", async () => {
    requireModuleMock.mockResolvedValue(sessionAs("VIEWER"));
    expect(await finalizeEntriesAction({ entryIds: ["a"] })).toMatchObject({ status: "error" });
    expect(finalizeMock).not.toHaveBeenCalled();
  });
});
