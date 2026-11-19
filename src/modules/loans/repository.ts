import Decimal from "decimal.js";
import { getPrisma } from "@/lib/db";
import { assertCurrency } from "@/lib/money";
import type {
  LoanInsuranceMode,
  LoanPurpose,
  LoanSummary,
  LoanWriteInput,
} from "./domain";

/**
 * Loan persistence (M21-01).
 *
 * Every function takes the workspace identifier and filters on it: a loan from another
 * workspace reads as "not found", like an unknown one. Archived rows are read like any
 * other — the listing carries the flag — and the archive stamp is the only column a
 * soft deletion touches. Nothing here deletes a loan: a record that carries links or a
 * property reference stays in history.
 */

type DecimalLike = { toString(): string };

const LOAN_SELECT = {
  id: true,
  label: true,
  lender: true,
  notes: true,
  purpose: true,
  currency: true,
  initialPrincipal: true,
  annualRate: true,
  termMonths: true,
  startDate: true,
  firstDueDate: true,
  paymentDay: true,
  interestOnlyMonths: true,
  insuranceMode: true,
  insuranceMonthlyAmount: true,
  insuranceRate: true,
  fees: true,
  propertyId: true,
  outstandingBalance: true,
  balanceAsOf: true,
  archivedAt: true,
  createdAt: true,
  updatedAt: true,
  property: { select: { name: true } },
} as const;

type LoanRow = {
  id: string;
  label: string;
  lender: string | null;
  notes: string | null;
  purpose: string;
  currency: string;
  initialPrincipal: DecimalLike;
  annualRate: DecimalLike | null;
  termMonths: number | null;
  startDate: Date | null;
  firstDueDate: Date | null;
  paymentDay: number | null;
  interestOnlyMonths: number;
  insuranceMode: string | null;
  insuranceMonthlyAmount: DecimalLike | null;
  insuranceRate: DecimalLike | null;
  fees: DecimalLike | null;
  propertyId: string | null;
  outstandingBalance: DecimalLike | null;
  balanceAsOf: Date | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  property: { name: string } | null;
};

function decimal(value: DecimalLike | null): Decimal | null {
  return value === null ? null : new Decimal(value.toString());
}

function toLoanSummary(row: LoanRow): LoanSummary {
  return {
    id: row.id,
    label: row.label,
    lender: row.lender,
    notes: row.notes,
    purpose: row.purpose as LoanPurpose,
    currency: assertCurrency(row.currency),
    initialPrincipal: new Decimal(row.initialPrincipal.toString()),
    annualRate: decimal(row.annualRate),
    termMonths: row.termMonths,
    startDate: row.startDate,
    firstDueDate: row.firstDueDate,
    paymentDay: row.paymentDay,
    interestOnlyMonths: row.interestOnlyMonths,
    insuranceMode: row.insuranceMode as LoanInsuranceMode | null,
    insuranceMonthlyAmount: decimal(row.insuranceMonthlyAmount),
    insuranceRate: decimal(row.insuranceRate),
    fees: decimal(row.fees),
    propertyId: row.propertyId,
    propertyName: row.property?.name ?? null,
    outstandingBalance: decimal(row.outstandingBalance),
    balanceAsOf: row.balanceAsOf,
    archived: row.archivedAt !== null,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Every loan of the workspace, archived ones included, active first. */
export async function listLoans(workspaceId: string): Promise<LoanSummary[]> {
  const rows = await getPrisma().loan.findMany({
    where: { workspaceId },
    orderBy: [{ archivedAt: { sort: "asc", nulls: "first" } }, { label: "asc" }],
    select: LOAN_SELECT,
  });

  return rows.map(toLoanSummary);
}

/**
 * The active loans a selection form may offer. An archived loan stays readable in
 * history but never appears in a picker, so it cannot be attached to a new record.
 */
export async function listSelectableLoans(workspaceId: string): Promise<LoanSummary[]> {
  const rows = await getPrisma().loan.findMany({
    where: { workspaceId, archivedAt: null },
    orderBy: { label: "asc" },
    select: LOAN_SELECT,
  });

  return rows.map(toLoanSummary);
}

/** One loan by identifier, archived ones included; a foreign id reads as not found. */
export async function findLoan(
  workspaceId: string,
  loanId: string,
): Promise<LoanSummary | null> {
  const row = await getPrisma().loan.findFirst({
    where: { id: loanId, workspaceId },
    select: LOAN_SELECT,
  });

  return row ? toLoanSummary(row) : null;
}

export type LoanCreateInput = LoanWriteInput & {
  workspaceId: string;
  /** Legacy author column; nullable by design. */
  userId?: string | null;
};

/** Amounts are stored as exact two-decimal strings, rates with at most four decimals. */
function amountData(value: Decimal | null): string | null {
  return value === null ? null : value.toFixed(2);
}

function rateData(value: Decimal | null): string | null {
  return value === null ? null : value.toFixed(4);
}

function toLoanData(input: LoanWriteInput) {
  return {
    label: input.label.trim(),
    lender: input.lender,
    notes: input.notes,
    purpose: input.purpose,
    currency: input.currency,
    initialPrincipal: input.initialPrincipal.toFixed(2),
    annualRate: rateData(input.annualRate),
    termMonths: input.termMonths,
    startDate: input.startDate,
    firstDueDate: input.firstDueDate,
    paymentDay: input.paymentDay,
    interestOnlyMonths: input.interestOnlyMonths,
    insuranceMode: input.insuranceMode,
    insuranceMonthlyAmount: amountData(input.insuranceMonthlyAmount),
    insuranceRate: rateData(input.insuranceRate),
    fees: amountData(input.fees),
    propertyId: input.propertyId,
    outstandingBalance: amountData(input.outstandingBalance),
    balanceAsOf: input.balanceAsOf,
  };
}

export async function createLoan(input: LoanCreateInput): Promise<{ id: string }> {
  return getPrisma().loan.create({
    data: {
      workspaceId: input.workspaceId,
      userId: input.userId ?? null,
      ...toLoanData(input),
    },
    select: { id: true },
  });
}

/** Updates workspace-scoped only: a loan from another workspace matches nothing. */
export async function updateLoan(
  workspaceId: string,
  loanId: string,
  input: LoanWriteInput,
): Promise<boolean> {
  const { count } = await getPrisma().loan.updateMany({
    where: { id: loanId, workspaceId },
    data: toLoanData(input),
  });

  return count === 1;
}

/**
 * Archives or restores a loan.
 *
 * Only the stamp changes: every field, the property link and the history stay.
 * Restoring clears the stamp, which makes the loan selectable again.
 */
export async function setLoanArchived(
  workspaceId: string,
  loanId: string,
  archived: boolean,
): Promise<boolean> {
  const { count } = await getPrisma().loan.updateMany({
    where: { id: loanId, workspaceId },
    data: { archivedAt: archived ? new Date() : null },
  });

  return count === 1;
}
