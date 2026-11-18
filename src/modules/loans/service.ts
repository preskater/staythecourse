import { findProperty } from "@/modules/real-estate/repository";
import {
  groupLoansByCurrency,
  normaliseInsuranceFields,
  resolvePaymentDay,
  type LoanCurrencyGroup,
  type LoanWriteInput,
  type ValidatedLoanInput,
} from "./domain";
import {
  createLoan,
  listLoans,
  updateLoan,
  type LoanCreateInput,
} from "./repository";

/**
 * Server-side assembly of a loan write (M21-01).
 *
 * The action owns the authorisation checks; this module turns a validated payload into
 * the exact row the repository writes. It resolves the optional property inside the
 * session's workspace, derives the payment day from the first due date when the owner
 * left it empty, and drops the insurance figures the chosen mode does not use.
 */

export type LoanServiceRefusal = { ok: false; field: string; message: string };

function refusal(field: string, message: string): LoanServiceRefusal {
  return { ok: false, field, message };
}

/** A validated form payload plus what the action already knows about the session. */
export type PrepareLoanInput = {
  workspaceId: string;
  values: ValidatedLoanInput;
  /** Whether the real-estate module is active in the session's workspace. */
  canLinkProperty: boolean;
  /** The property already attached, for an edit; `null` for a creation. */
  currentPropertyId?: string | null;
};

export type PreparedLoanWrite =
  | { ok: true; value: LoanWriteInput }
  | LoanServiceRefusal;

/**
 * Resolves a validated payload into a repository write.
 *
 * A browser identifier is never trusted: the property is re-read with the workspace
 * scope. Linking a *new* property needs the real-estate entitlement, while keeping the
 * existing link untouched works even if that module is later disabled.
 */
export async function prepareLoanWrite(
  input: PrepareLoanInput,
): Promise<PreparedLoanWrite> {
  const values = input.values;
  const currentPropertyId = input.currentPropertyId ?? null;

  if (values.propertyId !== null) {
    const unchanged = values.propertyId === currentPropertyId;

    if (!unchanged && !input.canLinkProperty) {
      return refusal(
        "propertyId",
        "Le module Immobilier doit être actif dans cet espace pour lier un bien à un prêt.",
      );
    }

    const property = await findProperty(input.workspaceId, values.propertyId);
    if (!property) {
      return refusal(
        "propertyId",
        "Bien introuvable dans cet espace : choisissez un bien existant.",
      );
    }
  }

  const insurance = normaliseInsuranceFields(values);

  return {
    ok: true,
    value: {
      label: values.label,
      lender: values.lender,
      notes: values.notes,
      purpose: values.purpose,
      currency: values.currency,
      initialPrincipal: values.initialPrincipal,
      annualRate: values.annualRate,
      termMonths: values.termMonths,
      startDate: values.startDate,
      firstDueDate: values.firstDueDate,
      paymentDay: resolvePaymentDay(values.firstDueDate, values.paymentDay),
      interestOnlyMonths: values.interestOnlyMonths,
      insuranceMode: values.insuranceMode,
      insuranceMonthlyAmount: insurance.insuranceMonthlyAmount,
      insuranceRate: insurance.insuranceRate,
      fees: values.fees,
      propertyId: values.propertyId,
      outstandingBalance: values.outstandingBalance,
      balanceAsOf: values.balanceAsOf,
    },
  };
}

export type LoanCreateOutcome =
  | { ok: true; id: string }
  | LoanServiceRefusal;

export async function createLoanForWorkspace(input: {
  workspaceId: string;
  userId: string;
  values: ValidatedLoanInput;
  canLinkProperty: boolean;
}): Promise<LoanCreateOutcome> {
  const prepared = await prepareLoanWrite({
    workspaceId: input.workspaceId,
    values: input.values,
    canLinkProperty: input.canLinkProperty,
  });

  if (!prepared.ok) {
    return prepared;
  }

  const write: LoanCreateInput = {
    workspaceId: input.workspaceId,
    userId: input.userId,
    ...prepared.value,
  };

  return { ok: true, id: (await createLoan(write)).id };
}

export type LoanUpdateOutcome = { ok: true } | LoanServiceRefusal;

export async function updateLoanForWorkspace(input: {
  workspaceId: string;
  loanId: string;
  currentPropertyId: string | null;
  values: ValidatedLoanInput;
  canLinkProperty: boolean;
}): Promise<LoanUpdateOutcome> {
  const prepared = await prepareLoanWrite({
    workspaceId: input.workspaceId,
    values: input.values,
    canLinkProperty: input.canLinkProperty,
    currentPropertyId: input.currentPropertyId,
  });

  if (!prepared.ok) {
    return prepared;
  }

  const updated = await updateLoan(input.workspaceId, input.loanId, prepared.value);
  if (!updated) {
    return refusal("id", "Prêt introuvable : il a peut-être été archivé ou supprimé entre-temps.");
  }

  return { ok: true };
}

/** The list page's data, grouped by currency and never summed across currencies. */
export async function listLoanGroups(workspaceId: string): Promise<LoanCurrencyGroup[]> {
  return groupLoansByCurrency(await listLoans(workspaceId));
}
