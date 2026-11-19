"use server";

import { revalidatePath } from "next/cache";
import {
  invalidResult,
  rejectedResult,
  unexpectedResult,
  type ActionResult,
} from "@/lib/actions";
import { requireModule } from "@/lib/auth/guard";
import { recordIdInput } from "@/lib/validation";
import { recordAuditEventSafely } from "@/modules/audit/repository";
import { hasModule } from "@/modules/catalog/catalog";
import { loanInputSchema, loanUpdateSchema } from "@/modules/loans/domain";
import { findLoan, setLoanArchived } from "@/modules/loans/repository";
import {
  createLoanForWorkspace,
  updateLoanForWorkspace,
} from "@/modules/loans/service";

/**
 * Write Server Actions for the loan registry (M21-01).
 *
 * A Server Action is a public endpoint: every action starts from the budget module's
 * write permission, re-parses the payload with the shared schema, and re-reads every
 * identifier with the session's workspace scope. Linking a property additionally
 * requires the real-estate module to be active.
 *
 * The audit metadata carries codes only — purpose, currency, insurance mode — never an
 * amount, a label, a lender or a note.
 */

const NOT_FOUND =
  "Prêt introuvable : il a peut-être été archivé ou supprimé entre-temps.";

function refreshLoans(): void {
  revalidatePath("/budget");
}

export async function createLoanAction(values: unknown): Promise<ActionResult> {
  const user = await requireModule("budget", "write");

  const parsed = loanInputSchema.safeParse(values);
  if (!parsed.success) {
    return invalidResult(parsed.error);
  }

  let created: { ok: true; id: string } | { ok: false; field: string; message: string };
  try {
    created = await createLoanForWorkspace({
      workspaceId: user.workspace.id,
      userId: user.id,
      values: parsed.data,
      canLinkProperty: hasModule(user.workspace, "real-estate"),
    });
  } catch (error) {
    return unexpectedResult("createLoan", error);
  }

  if (!created.ok) {
    return rejectedResult(created.field, created.message);
  }

  await recordAuditEventSafely({
    workspaceId: user.workspace.id,
    actorId: user.id,
    action: "loan.create",
    entityType: "LOAN",
    entityId: created.id,
    outcome: "SUCCESS",
    metadata: {
      purpose: parsed.data.purpose,
      currency: parsed.data.currency,
      insuranceMode: parsed.data.insuranceMode,
    },
  });

  refreshLoans();
  return { status: "ok" };
}

export async function updateLoanAction(values: unknown): Promise<ActionResult> {
  const user = await requireModule("budget", "write");

  const parsed = loanUpdateSchema.safeParse(values);
  if (!parsed.success) {
    return invalidResult(parsed.error);
  }

  const { id, ...fields } = parsed.data;

  try {
    // The identifier from the browser is a lookup key, not an authorisation.
    const existing = await findLoan(user.workspace.id, id);
    if (!existing) {
      return rejectedResult("id", NOT_FOUND);
    }

    const outcome = await updateLoanForWorkspace({
      workspaceId: user.workspace.id,
      loanId: existing.id,
      currentPropertyId: existing.propertyId,
      values: fields,
      canLinkProperty: hasModule(user.workspace, "real-estate"),
    });

    if (!outcome.ok) {
      return rejectedResult(outcome.field, outcome.message);
    }
  } catch (error) {
    return unexpectedResult("updateLoan", error);
  }

  await recordAuditEventSafely({
    workspaceId: user.workspace.id,
    actorId: user.id,
    action: "loan.update",
    entityType: "LOAN",
    entityId: id,
    outcome: "SUCCESS",
    metadata: {
      purpose: fields.purpose,
      currency: fields.currency,
      insuranceMode: fields.insuranceMode,
      propertyLinked: fields.propertyId !== null,
    },
  });

  refreshLoans();
  return { status: "ok" };
}

export async function archiveLoanAction(values: unknown): Promise<ActionResult> {
  return setArchived(values, true);
}

export async function restoreLoanAction(values: unknown): Promise<ActionResult> {
  return setArchived(values, false);
}

async function setArchived(values: unknown, archived: boolean): Promise<ActionResult> {
  const user = await requireModule("budget", "write");

  const parsed = recordIdInput.safeParse(values);
  if (!parsed.success) {
    return invalidResult(parsed.error);
  }

  try {
    const updated = await setLoanArchived(user.workspace.id, parsed.data.id, archived);
    if (!updated) {
      return rejectedResult("id", NOT_FOUND);
    }
  } catch (error) {
    return unexpectedResult(archived ? "archiveLoan" : "restoreLoan", error);
  }

  await recordAuditEventSafely({
    workspaceId: user.workspace.id,
    actorId: user.id,
    action: archived ? "loan.archive" : "loan.restore",
    entityType: "LOAN",
    entityId: parsed.data.id,
    outcome: "SUCCESS",
  });

  refreshLoans();
  return {
    status: "ok",
    message: archived
      ? "Prêt archivé : il reste consultable dans l'historique et n'est plus proposé dans les formulaires."
      : "Prêt restauré : il est de nouveau proposé dans les formulaires.",
  };
}
