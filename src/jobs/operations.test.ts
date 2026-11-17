import { beforeEach, describe, expect, it, vi } from "vitest";

const findManyMock = vi.fn();
const recordAuditEventMock = vi.fn();

vi.mock("@/lib/db", () => ({
  getPrisma: () => ({ workspace: { findMany: (...args: unknown[]) => findManyMock(...args) } }),
}));
vi.mock("@/modules/audit/repository", () => ({
  recordAuditEvent: (...args: unknown[]) => recordAuditEventMock(...args),
}));

const {
  isOperationAction,
  recordOperationAudit,
  resolveOperatorWorkspaceId,
} = await import("./operations");

describe("isOperationAction", () => {
  it("accepts the two operator procedures only", () => {
    expect(isOperationAction("backup.run")).toBe(true);
    expect(isOperationAction("restore.run")).toBe(true);
    expect(isOperationAction("backup.delete")).toBe(false);
    expect(isOperationAction(null)).toBe(false);
  });
});

describe("resolveOperatorWorkspaceId", () => {
  beforeEach(() => {
    findManyMock.mockReset();
    delete process.env.AUDIT_WORKSPACE_ID;
  });

  it("resolves the single workspace of a single-owner deployment", async () => {
    findManyMock.mockResolvedValue([{ id: "ws-owner-1" }]);

    expect(await resolveOperatorWorkspaceId()).toBe("ws-owner-1");
  });

  it("uses the explicit override without a lookup", async () => {
    process.env.AUDIT_WORKSPACE_ID = "ws-explicit";

    expect(await resolveOperatorWorkspaceId()).toBe("ws-explicit");
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it("refuses to guess when several workspaces exist", async () => {
    findManyMock.mockResolvedValue([{ id: "ws-1" }, { id: "ws-2" }]);

    await expect(resolveOperatorWorkspaceId()).rejects.toThrow(/AUDIT_WORKSPACE_ID/);
  });

  it("refuses when the database has no workspace yet", async () => {
    findManyMock.mockResolvedValue([]);

    await expect(resolveOperatorWorkspaceId()).rejects.toThrow(/seed the owner/);
  });
});

describe("recordOperationAudit", () => {
  beforeEach(() => {
    recordAuditEventMock.mockReset().mockResolvedValue(undefined);
  });

  it("writes one operator entry through the one helper, without a web actor", async () => {
    await recordOperationAudit({
      action: "backup.run",
      outcome: "SUCCESS",
      workspaceId: "ws-owner-1",
    });

    expect(recordAuditEventMock).toHaveBeenCalledWith({
      workspaceId: "ws-owner-1",
      actorId: null,
      action: "backup.run",
      entityType: "OPERATION",
      outcome: "SUCCESS",
      metadata: undefined,
    });
  });
});
