import Decimal from "decimal.js";
import { assertCurrency, type Currency } from "@/lib/money";
import { getPrisma } from "@/lib/db";
import type { RecurrenceFrequency } from "@/modules/budget/recurrence";
import type {
  BillingModel,
  ClientSummary,
  ProjectStatus,
  ProjectSummary,
} from "./domain";
import type { BusinessExpenseKind, BusinessExpenseRecord } from "./expenses";

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
 * Recurring business expense persistence (M10-05).
 *
 * A definition is read and written as a whole; occurrences are never stored, so the
 * table has no unique date key to maintain and no materialisation can duplicate. Every
 * query is workspace-scoped.
 */

const BUSINESS_EXPENSE_SELECT = {
  id: true,
  label: true,
  vendor: true,
  kind: true,
  amount: true,
  currency: true,
  frequency: true,
  startDate: true,
  endDate: true,
  notes: true,
} as const;

type BusinessExpenseRow = {
  id: string;
  label: string;
  vendor: string | null;
  kind: string;
  amount: Decimal;
  currency: string;
  frequency: string;
  startDate: Date;
  endDate: Date | null;
  notes: string | null;
};

function toBusinessExpenseRecord(row: BusinessExpenseRow): BusinessExpenseRecord {
  return {
    id: row.id,
    label: row.label,
    vendor: row.vendor,
    kind: row.kind as BusinessExpenseKind,
    amount: new Decimal(row.amount.toString()),
    currency: assertCurrency(row.currency),
    frequency: row.frequency as RecurrenceFrequency,
    startDate: row.startDate,
    endDate: row.endDate,
    notes: row.notes,
  };
}

/** Every definition of the workspace, by start date then label. */
export async function listBusinessExpenses(
  workspaceId: string,
): Promise<BusinessExpenseRecord[]> {
  const rows = await getPrisma().businessExpense.findMany({
    where: { workspaceId },
    select: BUSINESS_EXPENSE_SELECT,
    orderBy: [{ startDate: "asc" }, { label: "asc" }],
  });

  return rows.map(toBusinessExpenseRecord);
}

export type BusinessExpenseWriteInput = {
  workspaceId: string;
  label: string;
  vendor: string | null;
  kind: BusinessExpenseKind;
  amount: Decimal;
  currency: Currency;
  frequency: RecurrenceFrequency;
  startDate: Date;
  endDate: Date | null;
  notes: string | null;
};

export async function createBusinessExpense(
  input: BusinessExpenseWriteInput,
): Promise<{ id: string }> {
  return getPrisma().businessExpense.create({
    data: {
      workspaceId: input.workspaceId,
      label: input.label.trim(),
      vendor: input.vendor,
      kind: input.kind,
      amount: input.amount.toFixed(2),
      currency: input.currency,
      frequency: input.frequency,
      startDate: input.startDate,
      endDate: input.endDate,
      notes: input.notes,
    },
    select: { id: true },
  });
}

/** Deletes one definition, workspace-scoped; `false` means "gone or not yours". */
export async function deleteBusinessExpense(
  workspaceId: string,
  expenseId: string,
): Promise<boolean> {
  const { count } = await getPrisma().businessExpense.deleteMany({
    where: { id: expenseId, workspaceId },
  });

  return count === 1;
}
