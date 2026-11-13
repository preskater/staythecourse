"use server";

import { revalidatePath } from "next/cache";
import {
  invalidResult,
  rejectedResult,
  unexpectedResult,
  type ActionResult,
} from "@/lib/actions";
import { todayDateOnly } from "@/lib/dates";
import { publicEnv } from "@/lib/env";
import { recordAuditEventSafely } from "@/modules/audit/repository";
import type { AuditAction } from "@/modules/audit/domain";
import { billingBehaviour } from "@/modules/micro-business/domain";
import {
  createRevenueDocument,
  createRevenueMovement,
  findProject,
  findRevenueDocument,
} from "@/modules/micro-business/repository";
import {
  creditNoteRefusedReason,
  paymentRefusedReason,
  refundRefusedReason,
  revenueDocumentInputSchema,
  revenueMovementInputSchema,
  statementOf,
  writeOffRefusedReason,
  type RevenueMovementType,
} from "@/modules/micro-business/revenue";
import { requireBusinessManager } from "./manager-guard";

/**
 * Write Server Actions for micro-business revenue (M10-02).
 *
 * Every amount is checked against the document's current statement on the server: a
 * payment never exceeds the outstanding balance, a refund never returns more than was
 * received, an invoice is never silently overpaid, and a credit note never makes the
 * balance negative. The checks read the rows just before writing.
 *
 * ponytail: the read-then-write pair is not serialized. Two simultaneous submissions
 * could each pass the check; this is a single-owner app, so the next page load would
 * still make the inconsistency visible. Wrap the statement read and the write in one
 * serializable transaction if multi-user writes ever land.
 */

const PROJECT_NOT_FOUND = "Projet introuvable : il a peut-être été archivé ou supprimé.";
const INVOICE_NOT_FOUND = "Facture introuvable : elle a peut-être été supprimée.";
const INVOICE_TARGET_REQUIRED = "Un avoir se rattache à une facture, pas à un autre avoir.";
const MOVEMENT_TARGET_REQUIRED = "Un encaissement, un remboursement ou une mise en perte se rattache à une facture.";
const NOT_BILLABLE =
  "Ce projet n'est pas facturable (interne ou non facturable) : aucun revenu ne peut lui être rattaché.";
const NO_CLIENT =
  "Ce projet facturable n'a pas de client : rattachez-lui un client avant d'enregistrer une facture.";
const ARCHIVED_PROJECT =
  "Ce projet est archivé : restaurez-le avant d'enregistrer une facture.";

const MOVEMENT_AUDIT_ACTION = {
  PAYMENT: "revenue.payment",
  REFUND: "revenue.refund",
  WRITE_OFF: "revenue.write_off",
} as const satisfies Record<RevenueMovementType, AuditAction>;

const MOVEMENT_SUCCESS_MESSAGE: Record<RevenueMovementType, string> = {
  PAYMENT: "Encaissement enregistré.",
  REFUND: "Remboursement enregistré.",
  WRITE_OFF: "Mise en perte enregistrée : le reste dû est abandonné.",
};

function refreshRevenuePages(): void {
  revalidatePath("/micro-business/revenue");
  revalidatePath("/micro-business");
}

export async function createRevenueDocumentAction(values: unknown): Promise<ActionResult> {
  const guard = await requireBusinessManager();
  if ("refusal" in guard) {
    return guard.refusal;
  }

  const parsed = revenueDocumentInputSchema.safeParse(values);
  if (!parsed.success) {
    return invalidResult(parsed.error);
  }

  const workspaceId = guard.user.workspace.id;
  const input = parsed.data;

  if (input.kind === "INVOICE") {
    if (input.projectId === null) {
      return rejectedResult("projectId", PROJECT_NOT_FOUND);
    }

    const project = await findProject(workspaceId, input.projectId);
    if (!project) {
      return rejectedResult("projectId", PROJECT_NOT_FOUND);
    }
    if (project.archived) {
      return rejectedResult("projectId", ARCHIVED_PROJECT);
    }
    if (!billingBehaviour(project.billingModel).billable) {
      return rejectedResult("projectId", NOT_BILLABLE);
    }
    if (project.clientId === null) {
      return rejectedResult("projectId", NO_CLIENT);
    }

    let created: { id: string };
    try {
      created = await createRevenueDocument({
        workspaceId,
        projectId: project.id,
        clientId: project.clientId,
        creditNoteForId: null,
        kind: "INVOICE",
        currency: project.currency,
        amount: input.amount,
        issuedOn: input.issuedOn,
        dueOn: input.dueOn,
        recognizedOn: input.recognizedOn,
        recognizedAmount: input.recognizedAmount,
        notes: input.notes,
      });
    } catch (error) {
      return unexpectedResult("createInvoice", error);
    }

    await recordAuditEventSafely({
      workspaceId,
      actorId: guard.user.id,
      action: "revenue.invoice",
      entityType: "REVENUE_DOCUMENT",
      entityId: created.id,
      outcome: "SUCCESS",
      metadata: { currency: project.currency, format: "INVOICE" },
    });

    refreshRevenuePages();
    return { status: "ok", message: "Facture enregistrée." };
  }

  if (input.creditNoteForId === null) {
    return rejectedResult("creditNoteForId", INVOICE_NOT_FOUND);
  }

  const invoice = await findRevenueDocument(workspaceId, input.creditNoteForId);
  if (!invoice) {
    return rejectedResult("creditNoteForId", INVOICE_NOT_FOUND);
  }
  if (invoice.kind !== "INVOICE") {
    return rejectedResult("creditNoteForId", INVOICE_TARGET_REQUIRED);
  }

  const asOf = todayDateOnly(publicEnv.NEXT_PUBLIC_DEFAULT_TIME_ZONE);
  const statement = statementOf(invoice, asOf);
  const refusal = creditNoteRefusedReason(
    statement,
    invoice.issuedOn,
    input.amount,
    input.issuedOn,
  );
  if (refusal) {
    return rejectedResult("amount", refusal);
  }

  let created: { id: string };
  try {
    created = await createRevenueDocument({
      workspaceId,
      projectId: invoice.projectId,
      clientId: invoice.clientId,
      creditNoteForId: invoice.id,
      kind: "CREDIT_NOTE",
      currency: invoice.currency,
      amount: input.amount,
      issuedOn: input.issuedOn,
      dueOn: null,
      recognizedOn: null,
      recognizedAmount: null,
      notes: input.notes,
    });
  } catch (error) {
    return unexpectedResult("createCreditNote", error);
  }

  await recordAuditEventSafely({
    workspaceId,
    actorId: guard.user.id,
    action: "revenue.credit_note",
    entityType: "REVENUE_DOCUMENT",
    entityId: created.id,
    outcome: "SUCCESS",
    metadata: { currency: invoice.currency, format: "CREDIT_NOTE" },
  });

  refreshRevenuePages();
  return { status: "ok", message: "Avoir enregistré : il réduit le reste dû de la facture." };
}

export async function recordRevenueMovementAction(values: unknown): Promise<ActionResult> {
  const guard = await requireBusinessManager();
  if ("refusal" in guard) {
    return guard.refusal;
  }

  const parsed = revenueMovementInputSchema.safeParse(values);
  if (!parsed.success) {
    return invalidResult(parsed.error);
  }

  const workspaceId = guard.user.workspace.id;
  const input = parsed.data;
  const document = await findRevenueDocument(workspaceId, input.documentId);
  if (!document) {
    return rejectedResult("documentId", INVOICE_NOT_FOUND);
  }
  if (document.kind !== "INVOICE") {
    return rejectedResult("documentId", MOVEMENT_TARGET_REQUIRED);
  }

  const asOf = todayDateOnly(publicEnv.NEXT_PUBLIC_DEFAULT_TIME_ZONE);
  const statement = statementOf(document, asOf);
  const refusal =
    input.type === "PAYMENT"
      ? paymentRefusedReason(statement, input.amount)
      : input.type === "REFUND"
        ? refundRefusedReason(statement, input.amount)
        : writeOffRefusedReason(statement, input.amount);

  if (refusal) {
    return rejectedResult("amount", refusal);
  }

  try {
    await createRevenueMovement({
      type: input.type,
      workspaceId,
      documentId: document.id,
      amount: input.amount,
      date: input.date,
      notes: input.notes,
    });
  } catch (error) {
    return unexpectedResult("recordRevenueMovement", error);
  }

  await recordAuditEventSafely({
    workspaceId,
    actorId: guard.user.id,
    action: MOVEMENT_AUDIT_ACTION[input.type],
    entityType: "REVENUE_DOCUMENT",
    entityId: document.id,
    outcome: "SUCCESS",
    metadata: { currency: document.currency, movement: input.type },
  });

  refreshRevenuePages();
  return { status: "ok", message: MOVEMENT_SUCCESS_MESSAGE[input.type] };
}
