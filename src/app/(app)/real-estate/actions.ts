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
import { hasModule } from "@/modules/catalog/catalog";
import { recordIdInput } from "@/lib/validation";
import { DEFAULT_CURRENCY, formatMoney } from "@/lib/money";
import {
  cashflowInputSchema,
  propertyInputSchema,
  propertySaleInputSchema,
  propertyValuationInputSchema,
  propertyUpdateSchema,
} from "@/modules/real-estate/domain";
import { loanInputSchema, loanUpdateSchema } from "@/modules/real-estate/loans";
import {
  createCashflow,
  createLoan,
  createProperty,
  createPropertyValuation,
  deleteLoan,
  deleteProperty,
  findLoan,
  findProperty,
  getPropertyDetail,
  savePropertySale,
  updateLoan,
  updateProperty,
} from "@/modules/real-estate/repository";
import { computeSaleProceeds } from "@/modules/real-estate/valuation";
import { findTransactionRef } from "@/modules/budget/repository";

/**
 * Write Server Actions for the real-estate module.
 *
 * Same contract as the budget actions: authorisation first, validation with the
 * module schema, every identifier looked up for the signed-in owner.
 */

export async function createPropertyAction(values: unknown): Promise<ActionResult> {
  const user = await requireModule("real-estate", "write");

  const parsed = propertyInputSchema.safeParse(values);
  if (!parsed.success) {
    return invalidResult(parsed.error);
  }

  try {
    await createProperty({
      workspaceId: user.workspace.id,
      name: parsed.data.name,
      address: parsed.data.address,
      occupancy: parsed.data.occupancy,
      currency: parsed.data.currency ?? DEFAULT_CURRENCY,
      purchaseDate: parsed.data.purchaseDate,
      purchasePrice: parsed.data.purchasePrice,
      estimatedValue: parsed.data.estimatedValue,
      estimatedValueAsOf: parsed.data.estimatedValueAsOf,
      targetGainRate: parsed.data.targetGainRate,
      notes: parsed.data.notes,
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return rejectedResult("name", "Un autre bien porte déjà ce nom.");
    }

    return unexpectedResult("createProperty", error);
  }

  revalidatePath("/real-estate");
  revalidatePath("/dashboard");
  return { status: "ok" };
}

export async function createPropertyValuationAction(values: unknown): Promise<ActionResult> {
  const user = await requireModule("real-estate", "write");
  const parsed = propertyValuationInputSchema.safeParse(values);
  if (!parsed.success) {
    return invalidResult(parsed.error);
  }

  const input = parsed.data;
  const saved = await createPropertyValuation(user.workspace.id, input);
  if (!saved) {
    return rejectedResult("propertyId", "Bien introuvable : il a peut-être déjà été supprimé.");
  }

  revalidateProperty(input.propertyId);
  return { status: "ok" };
}

/**
 * Edits a property in place.
 *
 * The sale is deliberately absent from this contract: it is recorded through
 * `sellPropertyAction`, which validates the date, the price and the costs together.
 * The update therefore never clears an existing sale.
 */
export async function updatePropertyAction(values: unknown): Promise<ActionResult> {
  const user = await requireModule("real-estate", "write");

  const parsed = propertyUpdateSchema.safeParse(values);
  if (!parsed.success) {
    return invalidResult(parsed.error);
  }

  const input = parsed.data;

  const existing = await findProperty(user.workspace.id, input.id);
  if (!existing) {
    return rejectedResult("id", "Bien introuvable : il a peut-être déjà été supprimé.");
  }

  try {
    const { id, ...fields } = input;
    const updated = await updateProperty(user.workspace.id, id, {
      ...fields,
      currency: fields.currency ?? DEFAULT_CURRENCY,
    });

    if (!updated) {
      return rejectedResult("id", "Bien introuvable : il a peut-être déjà été supprimé.");
    }
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return rejectedResult("name", "Un autre bien porte déjà ce nom.");
    }

    return unexpectedResult("updateProperty", error);
  }

  revalidateProperty(input.id);
  return { status: "ok" };
}

/**
 * Erases a property with its cashflows and loans.
 *
 * The irreversible choice is the caller's, after the two-step confirmation. A sale
 * keeps the record; this action is for a property that should never have been tracked.
 */
export async function deletePropertyAction(values: unknown): Promise<ActionResult> {
  const user = await requireModule("real-estate", "write");

  const parsed = recordIdInput.safeParse(values);
  if (!parsed.success) {
    return invalidResult(parsed.error);
  }

  try {
    const deleted = await deleteProperty(user.workspace.id, parsed.data.id);
    if (!deleted) {
      return rejectedResult("id", "Bien introuvable : il a peut-être déjà été supprimé.");
    }
  } catch (error) {
    return unexpectedResult("deleteProperty", error);
  }

  revalidateProperty(parsed.data.id);
  return {
    status: "ok",
    message: "Bien supprimé, avec ses flux et ses financements.",
  };
}

/**
 * Records a sale: the property keeps its history, and the gain is told explicitly.
 *
 * The gain is computed server-side from the recorded acquisition price, operating
 * totals and loan balances — the client preview is a comfort, never the reference.
 * It stays "unknown" (with its reason) when a figure it needs was never entered.
 */
export async function sellPropertyAction(values: unknown): Promise<ActionResult> {
  const user = await requireModule("real-estate", "write");

  const parsed = propertySaleInputSchema.safeParse(values);
  if (!parsed.success) {
    return invalidResult(parsed.error);
  }

  const input = parsed.data;

  const detail = await getPropertyDetail(user.workspace.id, input.id);
  if (!detail) {
    return rejectedResult("id", "Bien introuvable : il a peut-être déjà été supprimé.");
  }

  if (
    detail.purchaseDate &&
    input.saleDate.getTime() < detail.purchaseDate.getTime()
  ) {
    return rejectedResult(
      "saleDate",
      "La date de cession doit suivre la date d'acquisition.",
    );
  }

  const netProceeds = computeSaleProceeds({
    salePrice: input.salePrice,
    saleCosts: input.saleCosts,
    outstandingDebt: detail.analysis.outstandingDebt,
  });

  const gain =
    netProceeds !== null && detail.analysis.netInvested !== null
      ? netProceeds.minus(detail.analysis.netInvested)
      : null;

  try {
    const saved = await savePropertySale(user.workspace.id, input.id, {
      saleDate: input.saleDate,
      salePrice: input.salePrice,
      saleCosts: input.saleCosts,
    });

    if (!saved) {
      return rejectedResult("id", "Bien introuvable : il a peut-être déjà été supprimé.");
    }
  } catch (error) {
    return unexpectedResult("sellProperty", error);
  }

  revalidateProperty(input.id);

  const prefix = detail.saleDate ? "Cession mise à jour" : "Cession enregistrée";

  if (gain !== null) {
    return {
      status: "ok",
      message: `${prefix}. Gain net : ${formatMoney({
        amount: gain,
        currency: detail.priceCurrency,
      })}.`,
    };
  }

  if (netProceeds !== null) {
    return {
      status: "ok",
      message: `${prefix}. Produit net : ${formatMoney({
        amount: netProceeds,
        currency: detail.priceCurrency,
      })}. Gain inconnu : le prix d'acquisition n'est pas renseigné.`,
    };
  }

  return {
    status: "ok",
    message:
      "Cession enregistrée. Gain inconnu : le prix d'acquisition ou le solde d'un prêt n'est pas renseigné.",
  };
}

/** The list and the property's detail page are both server-rendered. */
function revalidateProperty(propertyId: string): void {
  revalidatePath("/real-estate");
  revalidatePath(`/real-estate/${propertyId}`);
  revalidatePath("/dashboard");
}

export async function createCashflowAction(values: unknown): Promise<ActionResult> {
  const user = await requireModule("real-estate", "write");

  const parsed = cashflowInputSchema.safeParse(values);
  if (!parsed.success) {
    return invalidResult(parsed.error);
  }

  const input = parsed.data;

  const property = await findProperty(user.workspace.id, input.propertyId);
  if (!property) {
    return rejectedResult("propertyId", "Bien introuvable.");
  }

  // Exactly one of these is set: `cashflowInputSchema` enforces the exclusivity
  // that keeps a linked transaction from being counted twice.
  let currency = input.currency ?? DEFAULT_CURRENCY;

  if (input.transactionId) {
    // Linking reads the ledger: refused when the budget module is not active here.
    if (!hasModule(user.workspace, "budget")) {
      return rejectedResult("transactionId", "Transaction introuvable.");
    }

    const transaction = await findTransactionRef(user.workspace.id, input.transactionId);
    if (!transaction) {
      return rejectedResult("transactionId", "Transaction introuvable.");
    }

    // The linked transaction is the single source of truth, currency included:
    // a different one would make the property total mix two currencies.
    currency = transaction.currency;
  }

  try {
    await createCashflow({
      propertyId: property.id,
      kind: input.kind,
      label: input.label,
      amount: input.amount,
      transactionId: input.transactionId,
      currency,
      dueDate: input.dueDate,
      settledAt: input.settledAt,
      notes: input.notes,
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return rejectedResult(
        "transactionId",
        "Cette transaction est déjà rattachée à un flux.",
      );
    }

    return unexpectedResult("createCashflow", error);
  }

  revalidatePath("/real-estate");
  revalidatePath("/dashboard");
  return { status: "ok" };
}

/**
 * Write Server Actions for property financing (RE-01).
 *
 * A loan never feeds the operating totals: financing is a separate concept shown
 * beside the cashflow figures. Every identifier from the browser is looked up for the
 * signed-in owner — a property or a loan from another owner simply matches nothing.
 */

export async function createLoanAction(values: unknown): Promise<ActionResult> {
  const user = await requireModule("real-estate", "write");

  const parsed = loanInputSchema.safeParse(values);
  if (!parsed.success) {
    return invalidResult(parsed.error);
  }

  const input = parsed.data;

  const property = await findProperty(user.workspace.id, input.propertyId);
  if (!property) {
    return rejectedResult("propertyId", "Bien introuvable.");
  }

  try {
    // `input.propertyId` is the identifier just looked up for this owner.
    await createLoan(input);
  } catch (error) {
    return unexpectedResult("createLoan", error);
  }

  revalidatePath("/real-estate");
  return { status: "ok" };
}

export async function updateLoanAction(values: unknown): Promise<ActionResult> {
  const user = await requireModule("real-estate", "write");

  const parsed = loanUpdateSchema.safeParse(values);
  if (!parsed.success) {
    return invalidResult(parsed.error);
  }

  const input = parsed.data;

  const existing = await findLoan(user.workspace.id, input.id);
  if (!existing) {
    return rejectedResult("id", "Prêt introuvable : il a peut-être déjà été supprimé.");
  }

  const property = await findProperty(user.workspace.id, input.propertyId);
  if (!property) {
    return rejectedResult("propertyId", "Bien introuvable.");
  }

  try {
    const { id, ...fields } = input;
    const updated = await updateLoan(user.workspace.id, id, fields);
    if (!updated) {
      return rejectedResult("id", "Prêt introuvable : il a peut-être déjà été supprimé.");
    }
  } catch (error) {
    return unexpectedResult("updateLoan", error);
  }

  revalidatePath("/real-estate");
  return { status: "ok" };
}

export async function deleteLoanAction(values: unknown): Promise<ActionResult> {
  const user = await requireModule("real-estate", "write");

  const parsed = recordIdInput.safeParse(values);
  if (!parsed.success) {
    return invalidResult(parsed.error);
  }

  try {
    const deleted = await deleteLoan(user.workspace.id, parsed.data.id);
    if (!deleted) {
      return rejectedResult("id", "Prêt introuvable : il a peut-être déjà été supprimé.");
    }
  } catch (error) {
    return unexpectedResult("deleteLoan", error);
  }

  revalidatePath("/real-estate");
  return { status: "ok" };
}
