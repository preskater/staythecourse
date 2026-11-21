import { beforeEach, describe, expect, it, vi } from "vitest";

const projectMapping = { findMany: vi.fn(), create: vi.fn(), deleteMany: vi.fn() };
const project = { findFirst: vi.fn() };
const issueSnapshot = { findMany: vi.fn() };
const pullRequestSnapshot = { findMany: vi.fn() };
const projectSnapshot = { findMany: vi.fn() };

vi.mock("@/lib/db", () => ({
  getPrisma: () => ({ projectMapping, project, issueSnapshot, pullRequestSnapshot, projectSnapshot }),
}));

const { createProjectMapping, deleteProjectMapping, ProjectMappingError, readMappingReviewQueue, listKnownRepositories } =
  await import("./mapping.repository");

const input = { projectId: "p-1", repository: "acme/app", selector: "REPOSITORY" as const, value: "" };

beforeEach(() => {
  for (const group of [projectMapping, project, issueSnapshot, pullRequestSnapshot, projectSnapshot]) {
    for (const mock of Object.values(group)) mock.mockReset();
  }
  projectMapping.findMany.mockResolvedValue([]);
  issueSnapshot.findMany.mockResolvedValue([]);
  pullRequestSnapshot.findMany.mockResolvedValue([]);
});

describe("mapping writes", () => {
  it("refuses a project from another workspace before writing", async () => {
    project.findFirst.mockResolvedValue(null);
    await expect(createProjectMapping("ws-1", input)).rejects.toBeInstanceOf(ProjectMappingError);
    expect(project.findFirst.mock.calls[0][0].where).toEqual({ id: "p-1", workspaceId: "ws-1" });
    expect(projectMapping.create).not.toHaveBeenCalled();
  });

  it("explains a selector already mapped instead of failing blindly", async () => {
    project.findFirst.mockResolvedValue({ id: "p-1" });
    projectMapping.create.mockRejectedValue(Object.assign(new Error("unique"), { code: "P2002" }));
    await expect(createProjectMapping("ws-1", input)).rejects.toMatchObject({ field: "value" });
  });

  it("deletes within the workspace only", async () => {
    projectMapping.deleteMany.mockResolvedValue({ count: 0 });
    expect(await deleteProjectMapping("ws-other", "m-1")).toBe(false);
    expect(projectMapping.deleteMany).toHaveBeenCalledWith({ where: { id: "m-1", workspaceId: "ws-other" } });
  });
});

describe("readMappingReviewQueue", () => {
  it("lists ambiguous and unmapped open items, counts the resolved ones, all workspace-scoped", async () => {
    projectMapping.findMany.mockResolvedValue([
      { id: "m-1", projectId: "a", repository: "acme/app", selector: "LABEL", value: "client-a", project: { name: "A" } },
      { id: "m-2", projectId: "b", repository: "acme/app", selector: "LABEL", value: "client-b", project: { name: "B" } },
      { id: "m-3", projectId: "web", repository: "acme/app", selector: "PATH_PREFIX", value: "apps/web", project: { name: "Web" } },
    ]);
    issueSnapshot.findMany.mockResolvedValue([
      { repository: "acme/app", number: 1, title: "t1", url: "u1", labels: ["client-a"], milestone: null },
      { repository: "acme/app", number: 2, title: "t2", url: "u2", labels: ["client-a", "client-b"], milestone: null },
      { repository: "acme/other", number: 3, title: "t3", url: "u3", labels: [], milestone: null },
    ]);
    pullRequestSnapshot.findMany.mockResolvedValue([
      { repository: "acme/app", number: 4, title: "t4", url: "u4", headBranch: "x", files: [{ path: "apps/web/a.ts" }] },
    ]);

    const queue = await readMappingReviewQueue("ws-1");

    expect(queue.resolved).toBe(2);
    expect(queue.items.map((entry) => [entry.repository, entry.number, entry.resolution.status])).toEqual([
      ["acme/app", 2, "ambiguous"],
      ["acme/other", 3, "unmapped"],
    ]);
    expect(issueSnapshot.findMany.mock.calls[0][0].where).toMatchObject({ connection: { workspaceId: "ws-1" } });
    expect(pullRequestSnapshot.findMany.mock.calls[0][0].where).toMatchObject({ connection: { workspaceId: "ws-1" }, state: "OPEN" });
  });

  it("puts every open item in review when there is no rule", async () => {
    issueSnapshot.findMany.mockResolvedValue([{ repository: "acme/app", number: 1, title: "t", url: "u", labels: [], milestone: null }]);
    const queue = await readMappingReviewQueue("ws-1");
    expect(queue).toMatchObject({ resolved: 0, items: [{ resolution: { status: "unmapped" } }] });
  });

  it("suggests only the workspace's own repositories", async () => {
    projectSnapshot.findMany.mockResolvedValue([{ name: "Acme/App" }, { name: "acme/app" }]);
    expect(await listKnownRepositories("ws-1")).toEqual(["acme/app"]);
    expect(projectSnapshot.findMany.mock.calls[0][0].where).toEqual({ connection: { workspaceId: "ws-1" } });
  });
});
