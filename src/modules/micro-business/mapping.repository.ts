import { isUniqueConstraintError } from "@/lib/actions";
import { getPrisma } from "@/lib/db";
import {
  normalizeRepository,
  resolveProject,
  type ActivityItem,
  type MappingSelector,
  type ProjectMapping,
  type ProjectMappingInput,
  type Resolution,
} from "./mapping";

/**
 * Repository-to-project mapping persistence (M14-01).
 *
 * Workspace-scoped: a mapping, a project and the delivery snapshots it is resolved
 * against are all read through the workspace, so a repository name never crosses into
 * another workspace. Authorization is the caller's job.
 */

export class ProjectMappingError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = "ProjectMappingError";
  }
}

export type ProjectMappingRecord = ProjectMapping & { projectName: string };

/** How many open items the review queue reads per kind: the most recently active. */
export const REVIEW_QUEUE_LIMIT = 300;

export async function listProjectMappings(workspaceId: string): Promise<ProjectMappingRecord[]> {
  const rows = await getPrisma().projectMapping.findMany({
    where: { workspaceId },
    orderBy: [{ repository: "asc" }, { selector: "asc" }, { value: "asc" }],
    select: { id: true, projectId: true, repository: true, selector: true, value: true, project: { select: { name: true } } },
  });

  return rows.map(({ project, ...row }) => ({ ...row, selector: row.selector as MappingSelector, projectName: project.name }));
}

export async function createProjectMapping(workspaceId: string, input: ProjectMappingInput): Promise<{ id: string }> {
  const prisma = getPrisma();
  const project = await prisma.project.findFirst({ where: { id: input.projectId, workspaceId }, select: { id: true } });
  if (!project) throw new ProjectMappingError("projectId", "Projet introuvable dans cet espace.");

  try {
    return await prisma.projectMapping.create({
      data: { workspaceId, projectId: project.id, repository: input.repository, selector: input.selector, value: input.value },
      select: { id: true },
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new ProjectMappingError("value", "Ce sélecteur est déjà relié à un projet : supprimez la règle existante d'abord.");
    }
    throw error;
  }
}

/** `false` when the mapping is not in this workspace. */
export async function deleteProjectMapping(workspaceId: string, mappingId: string): Promise<boolean> {
  const { count } = await getPrisma().projectMapping.deleteMany({ where: { id: mappingId, workspaceId } });
  return count === 1;
}

/** Repository names the workspace's connections synchronised, for the form's suggestions. */
export async function listKnownRepositories(workspaceId: string): Promise<string[]> {
  const rows = await getPrisma().projectSnapshot.findMany({
    where: { connection: { workspaceId } },
    select: { name: true },
    orderBy: { name: "asc" },
    take: 500,
  });
  return [...new Set(rows.map((row) => normalizeRepository(row.name)).filter(Boolean))];
}

export type ReviewItem = {
  kind: "ISSUE" | "PULL_REQUEST";
  repository: string;
  number: number;
  title: string;
  url: string;
  resolution: Exclude<Resolution, { status: "resolved" }>;
};

export type ReviewQueue = { items: ReviewItem[]; resolved: number; truncated: boolean };

/**
 * Open issues and pull requests that no mapping attributes to exactly one project:
 * ambiguous or unmapped. Resolved items are only counted.
 */
export async function readMappingReviewQueue(workspaceId: string): Promise<ReviewQueue> {
  const prisma = getPrisma();
  const [mappings, issues, pulls] = await Promise.all([
    listProjectMappings(workspaceId),
    prisma.issueSnapshot.findMany({
      where: { connection: { workspaceId }, kind: "ISSUE" },
      orderBy: { activityAt: "desc" },
      take: REVIEW_QUEUE_LIMIT + 1,
      select: { repository: true, number: true, title: true, url: true, labels: true, milestone: true },
    }),
    prisma.pullRequestSnapshot.findMany({
      where: { connection: { workspaceId }, state: "OPEN" },
      orderBy: { providerUpdatedAt: "desc" },
      take: REVIEW_QUEUE_LIMIT + 1,
      select: { repository: true, number: true, title: true, url: true, headBranch: true, files: { select: { path: true } } },
    }),
  ]);

  const candidates: (Omit<ReviewItem, "resolution"> & { activity: ActivityItem })[] = [
    ...issues.slice(0, REVIEW_QUEUE_LIMIT).map((issue) => ({
      kind: "ISSUE" as const,
      repository: issue.repository,
      number: issue.number,
      title: issue.title,
      url: issue.url,
      activity: { repository: issue.repository, labels: issue.labels, milestone: issue.milestone, branch: null, paths: [] },
    })),
    ...pulls.slice(0, REVIEW_QUEUE_LIMIT).map((pull) => ({
      kind: "PULL_REQUEST" as const,
      repository: pull.repository,
      number: pull.number,
      title: pull.title,
      url: pull.url,
      activity: {
        repository: pull.repository,
        labels: [],
        milestone: null,
        branch: pull.headBranch,
        paths: pull.files.map((file) => file.path),
      },
    })),
  ];

  let resolved = 0;
  const items: ReviewItem[] = [];
  for (const { activity, ...item } of candidates) {
    const resolution = resolveProject(mappings, activity);
    if (resolution.status === "resolved") resolved += 1;
    else items.push({ ...item, resolution });
  }

  return {
    items: items.sort((a, b) => a.repository.localeCompare(b.repository) || a.number - b.number),
    resolved,
    truncated: issues.length > REVIEW_QUEUE_LIMIT || pulls.length > REVIEW_QUEUE_LIMIT,
  };
}
