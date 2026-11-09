import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EstimateVersionRecord } from "@/modules/micro-business/estimates";

const requireModuleMock = vi.fn();
const revalidatePathMock = vi.fn();
const recordAuditEventSafelyMock = vi.fn();
const findProjectMock = vi.fn();
const listEstimateVersionsMock = vi.fn();
const createEstimateVersionMock = vi.fn();
const approveEstimateVersionMock = vi.fn();

vi.mock("@/lib/auth/guard", () => ({
  requireModule: (...args: unknown[]) => requireModuleMock(...args),
}));
vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => revalidatePathMock(...args),
}));
vi.mock("@/modules/audit/repository", () => ({
  recordAuditEventSafely: (...args: unknown[]) => recordAuditEventSafelyMock(...args),
}));
vi.mock("@/modules/micro-business/repository", () => ({
  findProject: (...args: unknown[]) => findProjectMock(...args),
  listEstimateVersions: (...args: unknown[]) => listEstimateVersionsMock(...args),
  createEstimateVersion: (...args: unknown[]) => createEstimateVersionMock(...args),
  approveEstimateVersion: (...args: unknown[]) => approveEstimateVersionMock(...args),
}));

const { approveEstimateVersionAction, createEstimateVersionAction } = await import(
  "./estimate-actions"
);

/** Fictitious session; the workspace always comes from it, never from the request. */
function sessionAs(role: string) {
  return {
    id: "user-1",
    email: "owner@example.test",
    name: null,
    sessionId: "session-1",
    workspace: {
      id: "ws-user-1",
      name: "Entreprise",
      kind: "COMPANY",
      role,
      modules: ["micro-business"],
    },
  };
}

const project = {
  id: "project-1",
  name: "Refonte",
  clientId: "client-1",
  clientName: "Studio Lumen",
  billingModel: "FIXED_PRICE",
  status: "ACTIVE",
  currency: "EUR",
  startDate: null,
  endDate: null,
  notes: null,
  archived: false,
};

const version: EstimateVersionRecord = {
  id: "version-1",
  projectId: "project-1",
  projectName: "Refonte",
  versionNumber: 1,
  kind: "BASELINE",
  status: "APPROVED",
  currency: "EUR",
  assumptions: null,
  notes: null,
  approvedAt: new Date("2026-01-01T00:00:00Z"),
  items: [],
};

const versionPayload = {
  projectId: "project-1",
  kind: "BASELINE",
  assumptions: "",
  notes: "",
  items: "Développement | 1 000,00\nDesign | 500,00",
};

beforeEach(() => {
  vi.clearAllMocks();
  requireModuleMock.mockResolvedValue(sessionAs("OWNER"));
  findProjectMock.mockResolvedValue(project);
  listEstimateVersionsMock.mockResolvedValue([]);
  createEstimateVersionMock.mockResolvedValue({ id: "version-1", versionNumber: 1 });
  approveEstimateVersionMock.mockResolvedValue({ status: "approved", versionNumber: 1 });
});

describe("createEstimateVersionAction", () => {
  it("creates the baseline with its parsed lines and audits it", async () => {
    const result = await createEstimateVersionAction(versionPayload);

    expect(result.status).toBe("ok");
    expect(createEstimateVersionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-user-1",
        projectId: "project-1",
        kind: "BASELINE",
        assumptions: null,
        notes: null,
      }),
    );
    const saved = createEstimateVersionMock.mock.calls[0][0];
    expect(saved.items).toHaveLength(2);
    expect(saved.items[0].amount.toFixed(2)).toBe("1000.00");
    expect(recordAuditEventSafelyMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "estimate.version_create", entityType: "ESTIMATE" }),
    );
  });

  it("refuses a first version that is not the baseline", async () => {
    const result = await createEstimateVersionAction({
      ...versionPayload,
      kind: "REVISION",
    });

    expect(result.status).toBe("invalid");
    expect(result.status === "invalid" && result.message).toContain("première version");
    expect(createEstimateVersionMock).not.toHaveBeenCalled();
  });

  it("refuses a second baseline once a version exists", async () => {
    listEstimateVersionsMock.mockResolvedValue([version]);

    const result = await createEstimateVersionAction(versionPayload);

    expect(result.status).toBe("invalid");
    expect(result.status === "invalid" && result.message).toContain("existe déjà");
    expect(createEstimateVersionMock).not.toHaveBeenCalled();
  });

  it("refuses an archived project", async () => {
    findProjectMock.mockResolvedValue({ ...project, archived: true });

    const result = await createEstimateVersionAction(versionPayload);

    expect(result.status).toBe("invalid");
    expect(createEstimateVersionMock).not.toHaveBeenCalled();
  });

  it("refuses invalid lines before writing", async () => {
    const result = await createEstimateVersionAction({
      ...versionPayload,
      items: "Sans séparateur",
    });

    expect(result.status).toBe("invalid");
    expect(result.status === "invalid" && result.message).toContain("Ligne 1");
    expect(createEstimateVersionMock).not.toHaveBeenCalled();
  });

  it("reports a concurrent version instead of retrying blindly", async () => {
    createEstimateVersionMock.mockRejectedValue(
      Object.assign(new Error("unique"), { code: "P2002" }),
    );

    const result = await createEstimateVersionAction(versionPayload);

    expect(result.status).toBe("invalid");
    expect(result.status === "invalid" && result.message).toContain("rechargez");
  });

  it("refuses a member who may read but not write", async () => {
    requireModuleMock.mockResolvedValue(sessionAs("MEMBER"));

    const result = await createEstimateVersionAction(versionPayload);

    expect(result.status).toBe("error");
    expect(findProjectMock).not.toHaveBeenCalled();
  });
});

describe("approveEstimateVersionAction", () => {
  it("approves a draft and audits the transition", async () => {
    const result = await approveEstimateVersionAction({ id: "version-1" });

    expect(result.status).toBe("ok");
    expect(recordAuditEventSafelyMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "estimate.approve", entityType: "ESTIMATE" }),
    );
  });

  it("refuses a version that is no longer a draft", async () => {
    approveEstimateVersionMock.mockResolvedValue({
      status: "not_draft",
      currentStatus: "APPROVED",
    });

    const result = await approveEstimateVersionAction({ id: "version-1" });

    expect(result.status).toBe("invalid");
    expect(result.status === "invalid" && result.message).toContain("déjà approuvée");
    expect(recordAuditEventSafelyMock).not.toHaveBeenCalled();
  });

  it("refuses an unknown version", async () => {
    approveEstimateVersionMock.mockResolvedValue({ status: "not_found" });

    const result = await approveEstimateVersionAction({ id: "version-1" });

    expect(result.status).toBe("invalid");
    expect(recordAuditEventSafelyMock).not.toHaveBeenCalled();
  });

  it("refuses a member before touching the repository", async () => {
    requireModuleMock.mockResolvedValue(sessionAs("MEMBER"));

    const result = await approveEstimateVersionAction({ id: "version-1" });

    expect(result.status).toBe("error");
    expect(approveEstimateVersionMock).not.toHaveBeenCalled();
  });
});
