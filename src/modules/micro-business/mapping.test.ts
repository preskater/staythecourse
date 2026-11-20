import { describe, expect, it } from "vitest";
import {
  projectMappingInputSchema,
  resolveProject,
  type ActivityItem,
  type MappingSelector,
  type ProjectMapping,
} from "./mapping";

let sequence = 0;
function rule(projectId: string, selector: MappingSelector, value = "", repository = "acme/app"): ProjectMapping {
  return { id: `m-${++sequence}`, projectId, repository, selector, value };
}

function item(overrides: Partial<ActivityItem> = {}): ActivityItem {
  return { repository: "Acme/App", labels: [], milestone: null, branch: null, paths: [], ...overrides };
}

describe("resolveProject — precedence", () => {
  const mappings = [
    rule("repo-project", "REPOSITORY"),
    rule("milestone-project", "MILESTONE", "v2"),
    rule("label-project", "LABEL", "client-a"),
    rule("branch-project", "BRANCH", "feature/a"),
    rule("path-project", "PATH_PREFIX", "apps/web"),
  ];

  it.each([
    ["path prefix beats every other level", item({ paths: ["apps/web/page.tsx"], branch: "feature/a", labels: ["client-a"] }), "path-project"],
    ["branch beats label, milestone and repository", item({ branch: "feature/a", labels: ["client-a"], milestone: "v2" }), "branch-project"],
    ["label beats milestone and repository", item({ labels: ["Client-A"], milestone: "v2" }), "label-project"],
    ["milestone beats repository", item({ milestone: "v2" }), "milestone-project"],
    ["repository is the fallback", item({ labels: ["other"], paths: ["docs/readme.md"] }), "repo-project"],
  ])("%s", (_name, activity, expected) => {
    const resolution = resolveProject(mappings, activity);
    expect(resolution).toMatchObject({ status: "resolved", projectId: expected });
  });

  it("lets the longest path prefix win, on folder boundaries only", () => {
    const paths = [rule("parent", "PATH_PREFIX", "apps"), rule("child", "PATH_PREFIX", "apps/web")];
    expect(resolveProject(paths, item({ paths: ["apps/web/x.ts"] }))).toMatchObject({ projectId: "child" });
    expect(resolveProject(paths, item({ paths: ["apps/api/x.ts"] }))).toMatchObject({ projectId: "parent" });
    // "apps/webapp" is not under "apps/web".
    expect(resolveProject(paths, item({ paths: ["apps/webapp/x.ts"] }))).toMatchObject({ projectId: "parent" });
  });

  it("is deterministic whatever the order of the rules", () => {
    const activity = item({ labels: ["client-a", "client-b"] });
    const both = [rule("b", "LABEL", "client-b"), rule("a", "LABEL", "client-a")];
    expect(resolveProject(both, activity)).toEqual(resolveProject([...both].reverse(), activity));
  });
});

describe("resolveProject — ambiguity", () => {
  it("sends two projects at the deciding level to review, never to the lower level", () => {
    const resolution = resolveProject(
      [rule("a", "LABEL", "client-a"), rule("b", "LABEL", "client-b"), rule("fallback", "REPOSITORY")],
      item({ labels: ["client-a", "client-b"] }),
    );

    expect(resolution).toMatchObject({ status: "ambiguous", selector: "LABEL" });
    expect(resolution.status === "ambiguous" && resolution.candidates.map((candidate) => candidate.projectId)).toEqual(["a", "b"]);
  });

  it("flags a pull request whose files fall under two projects' folders", () => {
    const resolution = resolveProject(
      [rule("web", "PATH_PREFIX", "apps/web"), rule("api", "PATH_PREFIX", "apps/api")],
      item({ paths: ["apps/web/a.ts", "apps/api/b.ts", "README.md"] }),
    );
    expect(resolution).toMatchObject({ status: "ambiguous", selector: "PATH_PREFIX" });
  });

  it("is not ambiguous when two matches at one level name the same project", () => {
    const resolution = resolveProject(
      [rule("a", "LABEL", "client-a"), rule("a", "LABEL", "urgent")],
      item({ labels: ["client-a", "urgent"] }),
    );
    expect(resolution).toMatchObject({ status: "resolved", projectId: "a" });
  });
});

describe("resolveProject — empty mappings", () => {
  it("never attributes without a rule, nor through another repository's rules", () => {
    expect(resolveProject([], item({ labels: ["client-a"] }))).toEqual({ status: "unmapped" });
    expect(resolveProject([rule("a", "REPOSITORY", "", "acme/other")], item())).toEqual({ status: "unmapped" });
  });
});

describe("projectMappingInputSchema", () => {
  const parse = (values: Record<string, string>) =>
    projectMappingInputSchema.safeParse({ projectId: "p", repository: "Acme/App", selector: "REPOSITORY", value: "", ...values });

  it("normalises the repository, drops a whole-repository value and trims folder slashes", () => {
    const whole = parse({ value: "ignored" });
    expect(whole.success && [whole.data.repository, whole.data.value]).toEqual(["acme/app", ""]);

    const folder = parse({ selector: "PATH_PREFIX", value: "/apps/web/" });
    expect(folder.success && folder.data.value).toBe("apps/web");
  });

  it("refuses a missing value, a malformed repository and an unknown selector", () => {
    expect(parse({ selector: "LABEL" }).success).toBe(false);
    expect(parse({ repository: "no-owner" }).success).toBe(false);
    expect(parse({ selector: "AUTHOR" }).success).toBe(false);
  });
});
