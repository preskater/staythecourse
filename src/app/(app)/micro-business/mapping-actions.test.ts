import { beforeEach, describe, expect, it, vi } from "vitest";

const guardMock = vi.fn();
const createMock = vi.fn();
const deleteMock = vi.fn();
const recordAuditMock = vi.fn();

class ProjectMappingError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
  }
}

vi.mock("./manager-guard", () => ({ requireBusinessManager: () => guardMock() }));
vi.mock("@/modules/micro-business/mapping.repository", () => ({
  ProjectMappingError,
  createProjectMapping: (...args: unknown[]) => createMock(...args),
  deleteProjectMapping: (...args: unknown[]) => deleteMock(...args),
}));
vi.mock("@/modules/audit/repository", () => ({ recordAuditEventSafely: (...args: unknown[]) => recordAuditMock(...args) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { createProjectMappingAction, deleteProjectMappingAction } = await import("./mapping-actions");

/** Fictitious owner and values only. */
const OWNER = { id: "owner-1", workspace: { id: "ws-1", role: "OWNER" } };
const VALID = { projectId: "p-1", repository: "acme/app", selector: "LABEL", value: "client-a" };

beforeEach(() => {
  guardMock.mockReset().mockResolvedValue({ user: OWNER });
  createMock.mockReset().mockResolvedValue({ id: "m-1" });
  deleteMock.mockReset().mockResolvedValue(true);
  recordAuditMock.mockReset();
});

describe("createProjectMappingAction", () => {
  it("creates in the session's workspace and audits the selector, never the repository name", async () => {
    expect((await createProjectMappingAction(VALID)).status).toBe("ok");
    expect(createMock.mock.calls[0][0]).toBe("ws-1");
    expect(recordAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "project_mapping.create", entityId: "m-1", metadata: { selector: "LABEL" } }),
    );
  });

  it("writes nothing for a member or a viewer", async () => {
    guardMock.mockResolvedValue({ refusal: { status: "error", message: "refusé" } });
    expect((await createProjectMappingAction(VALID)).status).toBe("error");
    expect(createMock).not.toHaveBeenCalled();
  });

  it("reports a refused write on its field, and invalid input before any write", async () => {
    createMock.mockRejectedValue(new ProjectMappingError("value", "déjà relié"));
    const result = await createProjectMappingAction(VALID);
    expect(result.status === "invalid" && result.fieldErrors).toEqual({ value: ["déjà relié"] });

    expect((await createProjectMappingAction({ ...VALID, repository: "x" })).status).toBe("invalid");
    expect(recordAuditMock).not.toHaveBeenCalled();
  });
});

describe("deleteProjectMappingAction", () => {
  it("deletes and audits, or reports a foreign mapping as not found", async () => {
    expect((await deleteProjectMappingAction({ id: "m-1" })).status).toBe("ok");
    expect(recordAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "project_mapping.delete" }));

    deleteMock.mockResolvedValue(false);
    recordAuditMock.mockReset();
    expect((await deleteProjectMappingAction({ id: "m-x" })).status).toBe("invalid");
    expect(recordAuditMock).not.toHaveBeenCalled();
  });
});
