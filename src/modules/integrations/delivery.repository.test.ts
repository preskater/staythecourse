import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeliveryRepositoryResult } from "./adapter";
import type { ProviderPullRequest } from "./domain";

type Row = Record<string, unknown>;
const tables: Record<string, Row[]> = {};
let sequence = 0;

function table(name: string) {
  tables[name] ??= [];
  const rows = () => tables[name];
  const matches = (row: Row, where: Row) =>
    Object.entries(where).every(([key, value]) => {
      if (value && typeof value === "object" && "in" in (value as Row)) return ((value as Row).in as unknown[]).includes(row[key]);
      if (value && typeof value === "object" && "lt" in (value as Row)) return (row[key] as Date) < ((value as Row).lt as Date);
      if (key === "connection") return true;
      return row[key] === value;
    });

  return {
    findMany: vi.fn(async ({ where }: { where: Row }) => rows().filter((row) => matches(row, where))),
    upsert: vi.fn(async ({ where, create, update }: { where: Record<string, Row>; create: Row; update: Row }) => {
      const key = where.connectionId_externalId;
      const found = rows().find((row) => row.connectionId === key.connectionId && row.externalId === key.externalId);
      if (found) {
        Object.assign(found, update);
        return found;
      }
      const row = { id: `${name}-${++sequence}`, ...create };
      rows().push(row);
      return row;
    }),
    deleteMany: vi.fn(async ({ where }: { where: Row }) => {
      const before = rows().length;
      tables[name] = rows().filter((row) => !matches(row, where));
      return { count: before - tables[name].length };
    }),
    createMany: vi.fn(async ({ data }: { data: Row[] }) => {
      rows().push(...data.map((row) => ({ id: `${name}-${++sequence}`, ...row })));
      return { count: data.length };
    }),
  };
}

const prisma: Record<string, unknown> = {
  pullRequestSnapshot: table("pullRequestSnapshot"),
  pullRequestFile: table("pullRequestFile"),
  pullRequestReview: table("pullRequestReview"),
  pullRequestCommit: table("pullRequestCommit"),
  pullRequestIssueLink: table("pullRequestIssueLink"),
  releaseSnapshot: table("releaseSnapshot"),
  deploymentSnapshot: table("deploymentSnapshot"),
};
prisma.$transaction = vi.fn(async (callback: (tx: unknown) => unknown) => callback(prisma));

vi.mock("@/lib/db", () => ({ getPrisma: () => prisma }));
vi.mock("@/lib/env", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/env")>()) }));

const { pruneDeliveryHistory, saveDelivery } = await import("./repository");

const FETCHED_AT = new Date("2026-06-30T12:00:00.000Z");

function pr(overrides: Partial<ProviderPullRequest> = {}): ProviderPullRequest {
  return {
    externalId: "PR_1",
    repository: "acme/api",
    number: 12,
    title: "Ajoute l'export",
    url: "https://github.example/acme/api/pull/12",
    authorLogin: "dev-a",
    state: "MERGED",
    isDraft: false,
    baseBranch: "main",
    headBranch: "feature/export",
    additions: 120,
    deletions: 8,
    changedFiles: 2,
    commitsCount: 1,
    commentsCount: 4,
    reviewsCount: 2,
    openedAt: new Date("2026-06-18T09:00:00Z"),
    closedAt: new Date("2026-06-20T09:30:00Z"),
    mergedAt: new Date("2026-06-20T09:30:00Z"),
    updatedAt: new Date("2026-06-20T10:00:00Z"),
    childrenTruncated: false,
    files: [
      { path: "src/export.ts", additions: 100, deletions: 0, changeType: "ADDED" },
      { path: "src/index.ts", additions: 20, deletions: 8, changeType: "MODIFIED" },
    ],
    reviews: [
      { externalId: "R_2", authorLogin: "dev-b", state: "APPROVED", submittedAt: new Date("2026-06-19T16:00:00Z") },
      { externalId: "R_1", authorLogin: "dev-b", state: "CHANGES_REQUESTED", submittedAt: new Date("2026-06-19T11:00:00Z") },
    ],
    commits: [{ sha: "a1", authorLogin: "dev-a", committedAt: new Date("2026-06-18T09:00:00Z") }],
    issueLinks: [{ repository: "acme/api", issueNumber: 7, url: "https://github.example/acme/api/issues/7" }],
    ...overrides,
  };
}

function results(pullRequest = pr()): DeliveryRepositoryResult[] {
  return [
    {
      repository: "acme/api",
      read: true,
      windowTruncated: false,
      pullRequests: [pullRequest],
      releases: [
        { externalId: "REL_1", repository: "acme/api", tagName: "v1.2.0", name: "1.2.0", url: "https://github.example/r", isPrerelease: false, isDraft: false, releasedAt: FETCHED_AT, publishedAt: FETCHED_AT },
      ],
      deployments: [
        { externalId: "DEP_1", repository: "acme/api", environment: "production", sha: "a1", state: "SUCCESS", deployedAt: FETCHED_AT, statusUpdatedAt: FETCHED_AT },
      ],
    },
    { repository: "acme/locked", read: false, errorCode: "UNAUTHORIZED (HTTP 403)" },
  ];
}

const save = (input = results()) =>
  saveDelivery({ connectionId: "connection-1", provider: "GITHUB", results: input, fetchedAt: FETCHED_AT });

beforeEach(() => {
  for (const name of Object.keys(tables)) tables[name] = [];
  sequence = 0;
});

describe("saveDelivery", () => {
  it("stores a pull request with its children and the first review instant", async () => {
    expect(await save()).toEqual({ created: 3, updated: 0 });

    expect(tables.pullRequestSnapshot).toHaveLength(1);
    expect(tables.pullRequestSnapshot[0]).toMatchObject({
      connectionId: "connection-1",
      externalId: "PR_1",
      firstReviewAt: new Date("2026-06-19T11:00:00Z"),
      providerUpdatedAt: new Date("2026-06-20T10:00:00Z"),
    });
    expect(tables.pullRequestFile).toHaveLength(2);
    expect(tables.pullRequestReview).toHaveLength(2);
    expect(tables.pullRequestCommit).toHaveLength(1);
    expect(tables.pullRequestIssueLink).toHaveLength(1);
    expect(tables.releaseSnapshot).toHaveLength(1);
    expect(tables.deploymentSnapshot).toHaveLength(1);
  });

  it("a re-sync creates no duplicate and replaces the children", async () => {
    await save();
    const second = await save(results(pr({ files: [{ path: "src/export.ts", additions: 101, deletions: 0, changeType: "ADDED" }] })));

    expect(second).toEqual({ created: 0, updated: 3 });
    expect(tables.pullRequestSnapshot).toHaveLength(1);
    expect(tables.pullRequestFile).toEqual([expect.objectContaining({ path: "src/export.ts", additions: 101 })]);
    expect(tables.pullRequestReview).toHaveLength(2);
    expect(tables.releaseSnapshot).toHaveLength(1);
    expect(tables.deploymentSnapshot).toHaveLength(1);
  });

  it("a refused repository writes nothing and keeps earlier history", async () => {
    await save();
    expect(await save([{ repository: "acme/api", read: false, errorCode: "NOT_FOUND" }])).toEqual({ created: 0, updated: 0 });
    expect(tables.pullRequestSnapshot).toHaveLength(1);
  });
});

describe("pruneDeliveryHistory", () => {
  it("deletes only rows older than the cutoff", async () => {
    await save();
    await save(results(pr({ externalId: "PR_OLD", updatedAt: new Date("2025-01-01T00:00:00Z") })));

    const deleted = await pruneDeliveryHistory({ workspaceId: "ws-1", olderThan: new Date("2025-06-01T00:00:00Z") });

    expect(deleted).toBe(1);
    expect(tables.pullRequestSnapshot.map((row) => row.externalId)).toEqual(["PR_1"]);
  });
});
