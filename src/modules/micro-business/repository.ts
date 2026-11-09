import Decimal from "decimal.js";
import { assertCurrency, type Currency } from "@/lib/money";
import { getPrisma } from "@/lib/db";
import type {
  BillingModel,
  ClientSummary,
  ProjectStatus,
  ProjectSummary,
} from "./domain";
import type {
  EstimateItemInput,
  EstimateVersionKind,
  EstimateVersionRecord,
  EstimateVersionStatus,
} from "./estimates";

/**
 * Micro-business persistence. Every query is scoped to the workspace resolved from the
 * session; an identifier sent by a browser is therefore simply "not found" here.
 *
 * Archived rows are read like any other: the listing carries the `archived` flag, and
 * the archive stamp is the only column a write touches. Nothing is ever deleted.
 */

const CLIENT_SELECT = {
  id: true,
  name: true,
  contactName: true,
  email: true,
  notes: true,
  archivedAt: true,
  _count: { select: { projects: true } },
  projects: {
    where: { archivedAt: null, status: { not: "COMPLETED" } },
    select: { id: true },
  },
} as const;

type ClientRow = {
  id: string;
  name: string;
  contactName: string | null;
  email: string | null;
  notes: string | null;
  archivedAt: Date | null;
  _count: { projects: number };
  projects: { id: string }[];
};

const PROJECT_SELECT = {
  id: true,
  name: true,
  clientId: true,
  billingModel: true,
  status: true,
  currency: true,
  startDate: true,
  endDate: true,
  notes: true,
  archivedAt: true,
  client: { select: { name: true } },
} as const;

type ProjectRow = {
  id: string;
  name: string;
  clientId: string | null;
  billingModel: string;
  status: string;
  currency: string;
  startDate: Date | null;
  endDate: Date | null;
  notes: string | null;
  archivedAt: Date | null;
  client: { name: string } | null;
};

function toClientSummary(row: ClientRow): ClientSummary {
  return {
    id: row.id,
    name: row.name,
    contactName: row.contactName,
    email: row.email,
    notes: row.notes,
    archived: row.archivedAt !== null,
    projectCount: row._count.projects,
    activeProjectCount: row.projects.length,
  };
}

function toProjectSummary(row: ProjectRow): ProjectSummary {
  return {
    id: row.id,
    name: row.name,
    clientId: row.clientId,
    clientName: row.client?.name ?? null,
    billingModel: row.billingModel as BillingModel,
    status: row.status as ProjectStatus,
    currency: assertCurrency(row.currency),
    startDate: row.startDate,
    endDate: row.endDate,
    notes: row.notes,
    archived: row.archivedAt !== null,
  };
}

/** Every client of the workspace, archived ones included, active first. */
export async function listClients(workspaceId: string): Promise<ClientSummary[]> {
  const rows = await getPrisma().client.findMany({
    where: { workspaceId },
    select: CLIENT_SELECT,
    orderBy: [{ archivedAt: { sort: "asc", nulls: "first" } }, { name: "asc" }],
  });

  return rows.map(toClientSummary);
}

/** One client by identifier, archived ones included; used by the management screen. */
export async function findClient(
  workspaceId: string,
  clientId: string,
): Promise<ClientSummary | null> {
  const row = await getPrisma().client.findFirst({
    where: { id: clientId, workspaceId },
    select: CLIENT_SELECT,
  });

  return row ? toClientSummary(row) : null;
}

export type ClientWriteInput = {
  name: string;
  contactName: string | null;
  email: string | null;
  notes: string | null;
};

export async function createClient(
  input: ClientWriteInput & { workspaceId: string },
): Promise<{ id: string }> {
  return getPrisma().client.create({
    data: {
      workspaceId: input.workspaceId,
      name: input.name.trim(),
      contactName: input.contactName,
      email: input.email,
      notes: input.notes,
    },
    select: { id: true },
  });
}

/** Updates workspace-scoped only: a client from another workspace matches nothing. */
export async function updateClient(
  workspaceId: string,
  clientId: string,
  input: ClientWriteInput,
): Promise<boolean> {
  const { count } = await getPrisma().client.updateMany({
    where: { id: clientId, workspaceId },
    data: {
      name: input.name.trim(),
      contactName: input.contactName,
      email: input.email,
      notes: input.notes,
    },
  });

  return count === 1;
}

/**
 * Archives or restores a client.
 *
 * Only the stamp changes: the name, the contact details and every linked project stay,
 * and restoring clears the stamp without touching anything else.
 */
export async function setClientArchived(
  workspaceId: string,
  clientId: string,
  archived: boolean,
): Promise<boolean> {
  const { count } = await getPrisma().client.updateMany({
    where: { id: clientId, workspaceId },
    data: { archivedAt: archived ? new Date() : null },
  });

  return count === 1;
}

/** Every project of the workspace, archived ones included, active first. */
export async function listProjects(workspaceId: string): Promise<ProjectSummary[]> {
  const rows = await getPrisma().project.findMany({
    where: { workspaceId },
    select: PROJECT_SELECT,
    orderBy: [{ archivedAt: { sort: "asc", nulls: "first" } }, { name: "asc" }],
  });

  return rows.map(toProjectSummary);
}

/** One project by identifier, archived ones included. */
export async function findProject(
  workspaceId: string,
  projectId: string,
): Promise<ProjectSummary | null> {
  const row = await getPrisma().project.findFirst({
    where: { id: projectId, workspaceId },
    select: PROJECT_SELECT,
  });

  return row ? toProjectSummary(row) : null;
}

export type ProjectWriteInput = {
  name: string;
  clientId: string | null;
  billingModel: BillingModel;
  status: ProjectStatus;
  currency: Currency;
  startDate: Date | null;
  endDate: Date | null;
  notes: string | null;
};

function toProjectData(input: ProjectWriteInput) {
  return {
    name: input.name.trim(),
    clientId: input.clientId,
    billingModel: input.billingModel,
    status: input.status,
    currency: input.currency,
    startDate: input.startDate,
    endDate: input.endDate,
    notes: input.notes,
  };
}

/** The client must belong to the same workspace: a foreign identifier links nothing. */
async function clientBelongsToWorkspace(workspaceId: string, clientId: string): Promise<boolean> {
  const client = await getPrisma().client.findFirst({
    where: { id: clientId, workspaceId },
    select: { id: true },
  });

  return client !== null;
}

/** Creates a project, or `null` when its client does not belong to this workspace. */
export async function createProject(
  input: ProjectWriteInput & { workspaceId: string },
): Promise<{ id: string } | null> {
  if (input.clientId !== null && !(await clientBelongsToWorkspace(input.workspaceId, input.clientId))) {
    return null;
  }

  return getPrisma().project.create({
    data: { workspaceId: input.workspaceId, ...toProjectData(input) },
    select: { id: true },
  });
}

/** Updates workspace-scoped only; `null` means the client link is not allowed. */
export async function updateProject(
  workspaceId: string,
  projectId: string,
  input: ProjectWriteInput,
): Promise<boolean> {
  if (input.clientId !== null && !(await clientBelongsToWorkspace(workspaceId, input.clientId))) {
    return false;
  }

  const { count } = await getPrisma().project.updateMany({
    where: { id: projectId, workspaceId },
    data: toProjectData(input),
  });

  return count === 1;
}

/**
 * Archives or restores a project.
 *
 * The archive stamp is the only column written, so an archived project keeps its
 * billing model, its dates, its notes and its client link untouched.
 */
export async function setProjectArchived(
  workspaceId: string,
  projectId: string,
  archived: boolean,
): Promise<boolean> {
  const { count } = await getPrisma().project.updateMany({
    where: { id: projectId, workspaceId },
    data: { archivedAt: archived ? new Date() : null },
  });

  return count === 1;
}

/**
 * Estimate persistence (M10-04).
 *
 * A version and its lines are read together. Writes are deliberately narrow: create a
 * new version, or approve a draft. There is no update of an existing version, so an
 * approved figure can never be edited in place.
 */

const ESTIMATE_VERSION_SELECT = {
  id: true,
  projectId: true,
  versionNumber: true,
  kind: true,
  status: true,
  currency: true,
  assumptions: true,
  notes: true,
  approvedAt: true,
  project: { select: { name: true } },
  items: {
    select: { label: true, amount: true, position: true },
    orderBy: { position: "asc" },
  },
} as const;

type EstimateVersionRow = {
  id: string;
  projectId: string;
  versionNumber: number;
  kind: string;
  status: string;
  currency: string;
  assumptions: string | null;
  notes: string | null;
  approvedAt: Date | null;
  project: { name: string };
  items: { label: string; amount: Decimal; position: number }[];
};

function toEstimateVersionRecord(row: EstimateVersionRow): EstimateVersionRecord {
  return {
    id: row.id,
    projectId: row.projectId,
    projectName: row.project.name,
    versionNumber: row.versionNumber,
    kind: row.kind as EstimateVersionKind,
    status: row.status as EstimateVersionStatus,
    currency: assertCurrency(row.currency),
    assumptions: row.assumptions,
    notes: row.notes,
    approvedAt: row.approvedAt,
    items: row.items.map((item) => ({
      label: item.label,
      amount: new Decimal(item.amount.toString()),
      position: item.position,
    })),
  };
}

/**
 * Every version of the workspace, or of one project, ordered by project then version.
 *
 * The order is what the comparison selector and the table rely on: version numbers are
 * unique per project, so the history reads chronologically.
 */
export async function listEstimateVersions(
  workspaceId: string,
  projectId?: string,
): Promise<EstimateVersionRecord[]> {
  const rows = await getPrisma().estimateVersion.findMany({
    where: projectId ? { workspaceId, projectId } : { workspaceId },
    select: ESTIMATE_VERSION_SELECT,
    orderBy: { versionNumber: "asc" },
  });

  return rows
    .map(toEstimateVersionRecord)
    .sort(
      (left, right) =>
        left.projectName.localeCompare(right.projectName) ||
        left.versionNumber - right.versionNumber,
    );
}

export type EstimateVersionWriteInput = {
  workspaceId: string;
  projectId: string;
  kind: EstimateVersionKind;
  assumptions: string | null;
  notes: string | null;
  items: readonly EstimateItemInput[];
};

/**
 * Creates the next version of a project with its lines, in one nested write.
 *
 * `null` means the project is not in this workspace. The version number is max + 1;
 * the unique (projectId, versionNumber) constraint refuses a concurrent duplicate, and
 * the action reports it rather than retrying blindly.
 */
export async function createEstimateVersion(
  input: EstimateVersionWriteInput,
): Promise<{ id: string; versionNumber: number } | null> {
  const prisma = getPrisma();
  const project = await prisma.project.findFirst({
    where: { id: input.projectId, workspaceId: input.workspaceId },
    select: { currency: true },
  });

  if (!project) {
    return null;
  }

  const latest = await prisma.estimateVersion.findFirst({
    where: { workspaceId: input.workspaceId, projectId: input.projectId },
    orderBy: { versionNumber: "desc" },
    select: { versionNumber: true },
  });

  return prisma.estimateVersion.create({
    data: {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      versionNumber: (latest?.versionNumber ?? 0) + 1,
      kind: input.kind,
      currency: assertCurrency(project.currency),
      assumptions: input.assumptions,
      notes: input.notes,
      items: {
        create: input.items.map((item, index) => ({
          label: item.label,
          amount: item.amount.toFixed(2),
          position: index,
        })),
      },
    },
    select: { id: true, versionNumber: true },
  });
}

export type ApproveEstimateOutcome =
  | { status: "approved"; versionNumber: number }
  | { status: "not_found" }
  | { status: "not_draft"; currentStatus: EstimateVersionStatus };

/**
 * Approves a draft and supersedes the project's previous approved version.
 *
 * Both status writes share one transaction: a project never shows two approved
 * versions, and a failure leaves the previous one approved. The target row is read
 * first, workspace-scoped; a foreign or unknown identifier is "not found".
 */
export async function approveEstimateVersion(
  workspaceId: string,
  versionId: string,
): Promise<ApproveEstimateOutcome> {
  const prisma = getPrisma();
  const target = await prisma.estimateVersion.findFirst({
    where: { id: versionId, workspaceId },
    select: { projectId: true, status: true, versionNumber: true },
  });

  if (!target) {
    return { status: "not_found" };
  }
  if (target.status !== "DRAFT") {
    return {
      status: "not_draft",
      currentStatus: target.status as EstimateVersionStatus,
    };
  }

  const [, approved] = await prisma.$transaction([
    prisma.estimateVersion.updateMany({
      where: { workspaceId, projectId: target.projectId, status: "APPROVED" },
      data: { status: "SUPERSEDED" },
    }),
    prisma.estimateVersion.updateMany({
      where: { id: versionId, workspaceId, status: "DRAFT" },
      data: { status: "APPROVED", approvedAt: new Date() },
    }),
  ]);

  if (approved.count === 0) {
    // A concurrent approval won the race; the previous approved version was already
    // superseded, which is still a consistent history.
    return { status: "not_draft", currentStatus: "APPROVED" };
  }

  return { status: "approved", versionNumber: target.versionNumber };
}
