"use server";

import { revalidatePath } from "next/cache";
import {
  invalidResult,
  isUniqueConstraintError,
  rejectedResult,
  unexpectedResult,
  type ActionResult,
} from "@/lib/actions";
import { requireModule } from "@/lib/auth/guard";
import { recordIdInput } from "@/lib/validation";
import { invoiceInputSchema } from "@/modules/ai-costs/invoice";
import {
  createProviderInvoice,
  deleteProviderInvoice,
  InvalidInvoiceError,
} from "@/modules/ai-costs/invoice.repository";
import { recordAuditEventSafely } from "@/modules/audit/repository";
import { canManageBusinessRecords } from "@/modules/identity/workspace";

/**
 * Provider invoice writes (M11-06). Same bar as the inbox: session, module and role are
 * checked here, identifiers are only looked up inside the signed-in workspace, and the
 * audit entry carries the invoice id and a count, never an amount or a label.
 */

const MANAGER_MESSAGE = "Seuls le propriétaire et les administrateurs de l'espace peuvent saisir ou supprimer des factures.";

async function guard() {
  const user = await requireModule("ai-costs", "write");
  return canManageBusinessRecords(user.workspace.role) ? user : null;
}

export async function createInvoiceAction(values: unknown): Promise<ActionResult> {
  const user = await guard();
  if (!user) return { status: "error", message: MANAGER_MESSAGE };

  const parsed = invoiceInputSchema.safeParse(values);
  if (!parsed.success) return invalidResult(parsed.error);

  try {
    const { id } = await createProviderInvoice(user.workspace.id, parsed.data);
    await recordAuditEventSafely({
      workspaceId: user.workspace.id,
      actorId: user.id,
      action: "cost.invoice_create",
      entityType: "PROVIDER_INVOICE",
      entityId: id,
      outcome: "SUCCESS",
      metadata: { provider: parsed.data.provider, lines: parsed.data.lines.length },
    });
  } catch (error) {
    if (error instanceof InvalidInvoiceError) return rejectedResult(error.field, error.userMessage);
    if (isUniqueConstraintError(error)) {
      return rejectedResult("number", "Une facture de ce fournisseur porte déjà ce numéro.");
    }
    return unexpectedResult("invoiceCreate", error);
  }

  revalidatePath("/ai-costs/reconciliation");
  return { status: "ok" };
}

export async function deleteInvoiceAction(values: unknown): Promise<ActionResult> {
  const user = await guard();
  if (!user) return { status: "error", message: MANAGER_MESSAGE };

  const parsed = recordIdInput.safeParse(values);
  if (!parsed.success) return invalidResult(parsed.error);

  try {
    const deleted = await deleteProviderInvoice(user.workspace.id, parsed.data.id);
    if (!deleted) return { status: "error", message: "Facture introuvable dans cet espace." };
    await recordAuditEventSafely({
      workspaceId: user.workspace.id,
      actorId: user.id,
      action: "cost.invoice_delete",
      entityType: "PROVIDER_INVOICE",
      entityId: parsed.data.id,
      outcome: "SUCCESS",
    });
  } catch (error) {
    return unexpectedResult("invoiceDelete", error);
  }

  revalidatePath("/ai-costs/reconciliation");
  return { status: "ok" };
}
