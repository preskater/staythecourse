import Decimal from "decimal.js";
import { assertCurrency, type Currency } from "@/lib/money";
import { getPrisma } from "@/lib/db";
import type {
  BillingModel,
  ClientSummary,
  ProjectStatus,
  ProjectSummary,
} from "./domain";
import type { RevenueDocumentKind, RevenueDocumentRecord } from "./revenue";

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
 * Revenue persistence (M10-02).
 *
 * A document, its credit notes and its payments/refunds/write-offs are read together:
 * every derived figure needs the whole set, and reading it in one query keeps the page
 * free of N+1 lookups. Every query is workspace-scoped; a foreign identifier is simply
 * "not found".
 *
 * The write paths here do not re-check business rules (overpayment, credit-note
 * limits): the Server Actions compute the current statement first and refuse before
 * calling. A `ponytail:` note in the action names the single-user concurrency limit.
 */

const REVENUE_DOCUMENT_SELECT = {
  id: true,
  kind: true,
  projectId: true,
  clientId: true,
  currency: true,
  amount: true,
  issuedOn: true,
  dueOn: true,
  recognizedOn: true,
  recognizedAmount: true,
  notes: true,
  project: { select: { name: true } },
  client: { select: { name: true } },
  creditNoteFor: { select: { id: true, issuedOn: true } },
  creditedBy: { select: { id: true, amount: true, issuedOn: true } },
  payments: { select: { id: true, amount: true, paidOn: true } },
  refunds: { select: { id: true, amount: true, refundedOn: true } },
  writeOffs: { select: { id: true, amount: true, writtenOffOn: true } },
} as const;

type RevenueDocumentRow = {
  id: string;
  kind: string;
  projectId: string;
  clientId: string | null;
  currency: string;
  amount: Decimal;
  issuedOn: Date;
  dueOn: Date | null;
  recognizedOn: Date | null;
  recognizedAmount: Decimal | null;
  notes: string | null;
  project: { name: string };
  client: { name: string } | null;
  creditNoteFor: { id: string; issuedOn: Date } | null;
  creditedBy: { id: string; amount: Decimal; issuedOn: Date }[];
  payments: { id: string; amount: Decimal; paidOn: Date }[];
  refunds: { id: string; amount: Decimal; refundedOn: Date }[];
  writeOffs: { id: string; amount: Decimal; writtenOffOn: Date }[];
};

function toRevenueDocumentRecord(row: RevenueDocumentRow): RevenueDocumentRecord {
  return {
    id: row.id,
    kind: row.kind as RevenueDocumentKind,
    projectId: row.projectId,
    projectName: row.project.name,
    clientId: row.clientId,
    clientName: row.client?.name ?? null,
    currency: assertCurrency(row.currency),
    amount: new Decimal(row.amount.toString()),
    issuedOn: row.issuedOn,
    dueOn: row.dueOn,
    recognizedOn: row.recognizedOn,
    recognizedAmount:
      row.recognizedAmount === null ? null : new Decimal(row.recognizedAmount.toString()),
    notes: row.notes,
    creditNoteFor: row.creditNoteFor,
    creditedBy: row.creditedBy.map((note) => ({
      id: note.id,
      amount: new Decimal(note.amount.toString()),
      issuedOn: note.issuedOn,
    })),
    payments: row.payments.map((payment) => ({
      id: payment.id,
      amount: new Decimal(payment.amount.toString()),
      paidOn: payment.paidOn,
    })),
    refunds: row.refunds.map((refund) => ({
      id: refund.id,
      amount: new Decimal(refund.amount.toString()),
      refundedOn: refund.refundedOn,
    })),
    writeOffs: row.writeOffs.map((writeOff) => ({
      id: writeOff.id,
      amount: new Decimal(writeOff.amount.toString()),
      writtenOffOn: writeOff.writtenOffOn,
    })),
  };
}

/** Every document of the workspace, newest issue first. */
export async function listRevenueDocuments(
  workspaceId: string,
): Promise<RevenueDocumentRecord[]> {
  const rows = await getPrisma().revenueDocument.findMany({
    where: { workspaceId },
    select: REVENUE_DOCUMENT_SELECT,
    orderBy: [{ issuedOn: "desc" }, { createdAt: "desc" }],
  });

  return rows.map(toRevenueDocumentRecord);
}

/** One document by identifier, workspace-scoped, with every settling row. */
export async function findRevenueDocument(
  workspaceId: string,
  documentId: string,
): Promise<RevenueDocumentRecord | null> {
  const row = await getPrisma().revenueDocument.findFirst({
    where: { id: documentId, workspaceId },
    select: REVENUE_DOCUMENT_SELECT,
  });

  return row ? toRevenueDocumentRecord(row) : null;
}

export type RevenueDocumentWriteInput = {
  workspaceId: string;
  projectId: string;
  clientId: string | null;
  creditNoteForId: string | null;
  kind: RevenueDocumentKind;
  currency: Currency;
  amount: Decimal;
  issuedOn: Date;
  dueOn: Date | null;
  recognizedOn: Date | null;
  recognizedAmount: Decimal | null;
  notes: string | null;
};

export async function createRevenueDocument(
  input: RevenueDocumentWriteInput,
): Promise<{ id: string }> {
  return getPrisma().revenueDocument.create({
    data: {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      clientId: input.clientId,
      creditNoteForId: input.creditNoteForId,
      kind: input.kind,
      currency: input.currency,
      amount: input.amount.toFixed(2),
      issuedOn: input.issuedOn,
      dueOn: input.dueOn,
      recognizedOn: input.recognizedOn,
      recognizedAmount: input.recognizedAmount?.toFixed(2) ?? null,
      notes: input.notes,
    },
    select: { id: true },
  });
}

export type RevenueMovementWriteInput =
  | {
      type: "PAYMENT";
      workspaceId: string;
      documentId: string;
      amount: Decimal;
      date: Date;
      notes: string | null;
    }
  | {
      type: "REFUND";
      workspaceId: string;
      documentId: string;
      amount: Decimal;
      date: Date;
      notes: string | null;
    }
  | {
      type: "WRITE_OFF";
      workspaceId: string;
      documentId: string;
      amount: Decimal;
      date: Date;
      notes: string | null;
    };

/**
 * Records one settlement row on an invoice.
 *
 * The three tables share their shape but keep distinct columns (`paidOn`,
 * `refundedOn`, `writtenOffOn`), so a report can read each movement by its own day
 * without decoding a type. The caller has already checked the amount against the
 * statement.
 */
export async function createRevenueMovement(
  input: RevenueMovementWriteInput,
): Promise<{ id: string }> {
  // Re-checked here as well as in the action: a write keyed only by a browser-supplied
  // document id must never reach another workspace's invoice.
  const document = await getPrisma().revenueDocument.findFirst({
    where: { id: input.documentId, workspaceId: input.workspaceId },
    select: { id: true },
  });
  if (!document) {
    throw new Error("Revenue document not found in this workspace.");
  }

  const shared = {
    workspaceId: input.workspaceId,
    documentId: input.documentId,
    amount: input.amount.toFixed(2),
    notes: input.notes,
  };

  const prisma = getPrisma();

  switch (input.type) {
    case "PAYMENT":
      return prisma.revenuePayment.create({
        data: { ...shared, paidOn: input.date },
        select: { id: true },
      });
    case "REFUND":
      return prisma.revenueRefund.create({
        data: { ...shared, refundedOn: input.date },
        select: { id: true },
      });
    case "WRITE_OFF":
      return prisma.revenueWriteOff.create({
        data: { ...shared, writtenOffOn: input.date },
        select: { id: true },
      });
  }
}
