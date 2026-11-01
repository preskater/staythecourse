import { beforeEach, describe, expect, it, vi } from "vitest";

const requireModuleMock = vi.fn();
const revalidatePathMock = vi.fn();
const createClientMock = vi.fn();
const updateClientMock = vi.fn();
const findClientMock = vi.fn();
const setClientArchivedMock = vi.fn();
const createProjectMock = vi.fn();
const updateProjectMock = vi.fn();
const findProjectMock = vi.fn();
const setProjectArchivedMock = vi.fn();

vi.mock("@/lib/auth/guard", () => ({
  requireModule: (...args: unknown[]) => requireModuleMock(...args),
}));
vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => revalidatePathMock(...args),
}));
vi.mock("@/modules/micro-business/repository", () => ({
  createClient: (...args: unknown[]) => createClientMock(...args),
  updateClient: (...args: unknown[]) => updateClientMock(...args),
  findClient: (...args: unknown[]) => findClientMock(...args),
  setClientArchived: (...args: unknown[]) => setClientArchivedMock(...args),
  createProject: (...args: unknown[]) => createProjectMock(...args),
  updateProject: (...args: unknown[]) => updateProjectMock(...args),
  findProject: (...args: unknown[]) => findProjectMock(...args),
  setProjectArchived: (...args: unknown[]) => setProjectArchivedMock(...args),
}));

const {
  createClientAction,
  createProjectAction,
  setClientArchivedAction,
  setProjectArchivedAction,
  updateClientAction,
  updateProjectAction,
} = await import("./actions");

/** Fictitious session; the workspace always comes from it, never from the request. */
function sessionAs(role: string) {
  return {
    id: "user-1",
    email: "owner@example.test",
    name: null,
    sessionId: "session-1",
    workspace: {
      id: "ws-user-1",
      name: "Personnel",
      kind: "PERSONAL",
      role,
      modules: ["micro-business"],
    },
  };
}

const client = {
  id: "client-1",
  name: "Studio Lumen",
  contactName: null,
  email: null,
  notes: null,
  archived: false,
  projectCount: 1,
  activeProjectCount: 1,
};

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

const clientPayload = {
  name: "Studio Lumen",
  contactName: "",
  email: "",
  notes: "",
};

const projectPayload = {
  name: "Refonte",
  clientId: "client-1",
  billingModel: "FIXED_PRICE",
  status: "ACTIVE",
  currency: "EUR",
  startDate: "",
  endDate: "",
  notes: "",
};

beforeEach(() => {
  requireModuleMock.mockReset().mockResolvedValue(sessionAs("OWNER"));
  revalidatePathMock.mockReset();
  createClientMock.mockReset().mockResolvedValue({ id: "client-1" });
  updateClientMock.mockReset().mockResolvedValue(true);
  findClientMock.mockReset().mockResolvedValue(client);
  setClientArchivedMock.mockReset().mockResolvedValue(true);
  createProjectMock.mockReset().mockResolvedValue({ id: "project-1" });
  updateProjectMock.mockReset().mockResolvedValue(true);
  findProjectMock.mockReset().mockResolvedValue(project);
  setProjectArchivedMock.mockReset().mockResolvedValue(true);
});

describe("module and workspace resolution", () => {
  it("checks the module entitlement, not a client-supplied key", async () => {
    await createClientAction(clientPayload);

    expect(requireModuleMock).toHaveBeenCalledWith("micro-business");
  });

  it("writes into the session's workspace, ignoring a forged workspace id", async () => {
    const result = await createClientAction({ ...clientPayload, workspaceId: "ws-someone-else" });

    expect(result.status).toBe("ok");
    expect(createClientMock).toHaveBeenCalledWith({
      workspaceId: "ws-user-1",
      name: "Studio Lumen",
      contactName: null,
      email: null,
      notes: null,
    });
    expect(revalidatePathMock).toHaveBeenCalledWith("/micro-business");
  });
});

describe("authorisation per role", () => {
  const writes = [
    ["createClientAction", () => createClientAction(clientPayload)],
    ["updateClientAction", () => updateClientAction({ ...clientPayload, id: client.id })],
    ["setClientArchivedAction", () => setClientArchivedAction({ id: client.id, archived: "true" })],
    ["createProjectAction", () => createProjectAction(projectPayload)],
    ["updateProjectAction", () => updateProjectAction({ ...projectPayload, id: project.id })],
    ["setProjectArchivedAction", () => setProjectArchivedAction({ id: project.id, archived: "true" })],
  ] as const;

  it.each(["OWNER", "ADMIN"])("lets a %s write", async (role) => {
    requireModuleMock.mockResolvedValue(sessionAs(role));

    for (const [, run] of writes) {
      expect((await run()).status).toBe("ok");
    }
  });

  it.each(["MEMBER", "VIEWER"])("refuses a %s without writing anything", async (role) => {
    requireModuleMock.mockResolvedValue(sessionAs(role));

    for (const [, run] of writes) {
      const result = await run();
      expect(result.status).toBe("error");
      expect(result.status === "error" && result.message).toContain("propriétaire");
    }

    expect(createClientMock).not.toHaveBeenCalled();
    expect(updateClientMock).not.toHaveBeenCalled();
    expect(setClientArchivedMock).not.toHaveBeenCalled();
    expect(createProjectMock).not.toHaveBeenCalled();
    expect(updateProjectMock).not.toHaveBeenCalled();
    expect(setProjectArchivedMock).not.toHaveBeenCalled();
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });
});

describe("client actions", () => {
  it("refuses a payload that does not match the schema", async () => {
    const result = await createClientAction({ ...clientPayload, name: "  " });

    expect(result.status).toBe("invalid");
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it("reports a duplicate name on the name field", async () => {
    createClientMock.mockRejectedValue(Object.assign(new Error("unique"), { code: "P2002" }));

    const result = await createClientAction(clientPayload);

    expect(result).toMatchObject({ status: "invalid", fieldErrors: { name: ["Un autre client porte déjà ce nom."] } });
  });

  it("treats a foreign or deleted client as not found", async () => {
    findClientMock.mockResolvedValue(null);

    const result = await updateClientAction({ ...clientPayload, id: "client-other" });

    expect(result.status).toBe("invalid");
    expect(updateClientMock).not.toHaveBeenCalled();
  });

  it("archives through the stamp only", async () => {
    const result = await setClientArchivedAction({ id: client.id, archived: "true" });

    expect(result.status).toBe("ok");
    expect(setClientArchivedMock).toHaveBeenCalledWith("ws-user-1", client.id, true);
    expect(updateClientMock).not.toHaveBeenCalled();
  });
});

describe("project actions", () => {
  it("refuses a billable project without a client", async () => {
    const result = await createProjectAction({ ...projectPayload, clientId: "" });

    expect(result.status).toBe("invalid");
    expect(createProjectMock).not.toHaveBeenCalled();
  });

  it("refuses a client that belongs to another workspace", async () => {
    findClientMock.mockResolvedValue(null);

    const result = await createProjectAction(projectPayload);

    expect(result).toMatchObject({ status: "invalid", fieldErrors: { clientId: [expect.any(String)] } });
    expect(createProjectMock).not.toHaveBeenCalled();
  });

  it("creates an internal project without any client", async () => {
    const result = await createProjectAction({
      ...projectPayload,
      clientId: "",
      billingModel: "INTERNAL",
    });

    expect(result.status).toBe("ok");
    expect(findClientMock).not.toHaveBeenCalled();
    expect(createProjectMock).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-user-1", clientId: null, billingModel: "INTERNAL" }),
    );
  });

  it("reports a duplicate project name on the name field", async () => {
    createProjectMock.mockRejectedValue(Object.assign(new Error("unique"), { code: "P2002" }));

    const result = await createProjectAction(projectPayload);

    expect(result).toMatchObject({
      status: "invalid",
      fieldErrors: { name: ["Un autre projet porte déjà ce nom."] },
    });
  });

  it("archives without rewriting the project's data", async () => {
    const result = await setProjectArchivedAction({ id: project.id, archived: "true" });

    expect(result.status).toBe("ok");
    expect(setProjectArchivedMock).toHaveBeenCalledWith("ws-user-1", project.id, true);
    expect(updateProjectMock).not.toHaveBeenCalled();
    expect(revalidatePathMock).toHaveBeenCalledWith("/micro-business");
  });

  it("treats a foreign or deleted project as not found", async () => {
    findProjectMock.mockResolvedValue(null);

    const result = await updateProjectAction({ ...projectPayload, id: "project-other" });

    expect(result.status).toBe("invalid");
    expect(updateProjectMock).not.toHaveBeenCalled();
  });
});
