import Decimal from "decimal.js";
import { z } from "zod";
import { monthRange } from "@/lib/dates";
import { formatMoney, type Currency } from "@/lib/money";
import { amount, optionalAmount, optionalDate, optionalId, optionalText, requiredDate } from "@/lib/validation";

/**
 * Revenue documents of the micro-business module (M10-02).
 *
 * The lifecycle is a set of records, never a stored status:
 *
 * - an **invoice** is issued on a day with a positive amount and a due date;
 * - **credit notes** are explicit documents that name the invoice they reduce — a
 *   correction is never a negative invoice typed in silence;
 * - **payments**, **refunds** and **write-offs** are positive magnitudes with their
 *   own day, attached to an invoice.
 *
 * From those rows, `statementOf` derives the figures and the status: paid = payments
 * − refunds, outstanding = net issued − paid − written off. Overdue is `dueOn < asOf`
 * where `asOf` is the owner's calendar day (`todayDateOnly`), so a due date never
 * flips a day early or late because of the time zone.
 *
 * Recognition is a frozen snapshot on the invoice (`recognizedOn` +
 * `recognizedAmount`): later edits, credit notes or payments never rewrite a figure
 * that was recognized. Versioned recognition rules belong to M15-01.
 *
 * Amounts are exact decimals; currencies are never converted, so a statement only
 * ever adds its own document's currency.
 */

export const REVENUE_DOCUMENT_KINDS = ["INVOICE", "CREDIT_NOTE"] as const;
export type RevenueDocumentKind = (typeof REVENUE_DOCUMENT_KINDS)[number];

export const REVENUE_DOCUMENT_KIND_LABELS: Record<RevenueDocumentKind, string> = {
  INVOICE: "Facture",
  CREDIT_NOTE: "Avoir",
};

export const REVENUE_STATUSES = [
  "OPEN",
  "PARTIALLY_PAID",
  "PAID",
  "OVERDUE",
  "WRITTEN_OFF",
  "CREDITED",
] as const;
export type RevenueStatus = (typeof REVENUE_STATUSES)[number];

export const REVENUE_STATUS_LABELS: Record<RevenueStatus, string> = {
  OPEN: "Ouverte",
  PARTIALLY_PAID: "Partiellement payée",
  PAID: "Payée",
  OVERDUE: "En retard",
  WRITTEN_OFF: "Passée en perte",
  CREDITED: "Annulée par avoir",
};

export const REVENUE_MOVEMENT_TYPES = ["PAYMENT", "REFUND", "WRITE_OFF"] as const;
export type RevenueMovementType = (typeof REVENUE_MOVEMENT_TYPES)[number];

export const REVENUE_MOVEMENT_TYPE_LABELS: Record<RevenueMovementType, string> = {
  PAYMENT: "Encaissement",
  REFUND: "Remboursement",
  WRITE_OFF: "Mise en perte",
};

/** One received payment. */
export type RevenuePaymentRecord = {
  id: string;
  amount: Decimal;
  paidOn: Date;
};

/** One refund to the client. */
export type RevenueRefundRecord = {
  id: string;
  amount: Decimal;
  refundedOn: Date;
};

/** One explicit write-off. */
export type RevenueWriteOffRecord = {
  id: string;
  amount: Decimal;
  writtenOffOn: Date;
};

/** A credit note attached to an invoice. */
export type RevenueCreditNoteRecord = {
  id: string;
  amount: Decimal;
  issuedOn: Date;
};

/**
 * One document with the rows that settle it.
 *
 * `creditedBy` is filled for an invoice, `creditNoteFor` for a credit note; the other
 * side is empty. The repository scopes every row by workspace before this shape is
 * built.
 */
export type RevenueDocumentRecord = {
  id: string;
  kind: RevenueDocumentKind;
  projectId: string;
  projectName: string;
  /** Snapshot of the client at issue time; `null` when no client was linked. */
  clientId: string | null;
  clientName: string | null;
  currency: Currency;
  /** Positive magnitude. */
  amount: Decimal;
  issuedOn: Date;
  dueOn: Date | null;
  recognizedOn: Date | null;
  recognizedAmount: Decimal | null;
  notes: string | null;
  /** The invoice a credit note reduces, `null` on an invoice. */
  creditNoteFor: { id: string; issuedOn: Date } | null;
  /** Credit notes reducing this invoice, empty on a credit note. */
  creditedBy: RevenueCreditNoteRecord[];
  payments: RevenuePaymentRecord[];
  refunds: RevenueRefundRecord[];
  writeOffs: RevenueWriteOffRecord[];
};

/** Every derived figure of one invoice, in its own currency. */
export type RevenueStatement = {
  documentId: string;
  currency: Currency;
  /** The invoice amount as issued. */
  amount: Decimal;
  /** Credit notes issued against it. */
  credited: Decimal;
  /** amount − credited. */
  netIssued: Decimal;
  /** payments − refunds. */
  paid: Decimal;
  paymentsTotal: Decimal;
  refundsTotal: Decimal;
  writtenOff: Decimal;
  /** netIssued − paid − writtenOff. Negative only on inconsistent history. */
  outstanding: Decimal;
  status: RevenueStatus;
  /** Whole days past the due date as of `asOf`; 0 when not overdue. */
  overdueDays: number;
};

function sum(values: readonly Decimal[]): Decimal {
  return values.reduce((total, value) => total.plus(value), new Decimal(0));
}

/** A day index that ignores any time of day a caller may have left on the value. */
function dayNumber(value: Date): number {
  return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
}

/** Whole calendar days between two days (`later` minus `earlier`). */
function daysBetween(later: Date, earlier: Date): number {
  return Math.round((dayNumber(later) - dayNumber(earlier)) / 86_400_000);
}

/** Strict calendar-day comparison: the due day itself is never "before". */
function isBeforeDay(value: Date, reference: Date): boolean {
  return dayNumber(value) < dayNumber(reference);
}

/**
 * The invoice's derived figures, from its rows and the owner's current day.
 *
 * Status order matters and is documented here once: a fully credited invoice with
 * nothing settled reads `CREDITED`; a settled invoice with a write-off reads
 * `WRITTEN_OFF`; any other settled invoice reads `PAID`. An unsettled invoice past
 * its due day is `OVERDUE` (even when partly paid — the remaining balance is late),
 * otherwise `PARTIALLY_PAID` once something was received, otherwise `OPEN`.
 *
 * The due day itself is not overdue: the comparison is strict (`dueOn < asOf`).
 */
export function statementOf(document: RevenueDocumentRecord, asOf: Date): RevenueStatement {
  const credited = sum(document.creditedBy.map((note) => note.amount));
  const netIssued = document.amount.minus(credited);
  const paymentsTotal = sum(document.payments.map((payment) => payment.amount));
  const refundsTotal = sum(document.refunds.map((refund) => refund.amount));
  const paid = paymentsTotal.minus(refundsTotal);
  const writtenOff = sum(document.writeOffs.map((entry) => entry.amount));
  const outstanding = netIssued.minus(paid).minus(writtenOff);

  let status: RevenueStatus;
  if (outstanding.greaterThan(0)) {
    if (document.dueOn !== null && isBeforeDay(document.dueOn, asOf)) {
      status = "OVERDUE";
    } else if (paid.greaterThan(0)) {
      status = "PARTIALLY_PAID";
    } else {
      status = "OPEN";
    }
  } else if (writtenOff.greaterThan(0)) {
    status = "WRITTEN_OFF";
  } else if (paid.greaterThan(0)) {
    status = "PAID";
  } else {
    status = "CREDITED";
  }

  const overdueDays =
    document.dueOn !== null && isBeforeDay(document.dueOn, asOf)
      ? daysBetween(asOf, document.dueOn)
      : 0;

  return {
    documentId: document.id,
    currency: document.currency,
    amount: document.amount,
    credited,
    netIssued,
    paid,
    paymentsTotal,
    refundsTotal,
    writtenOff,
    outstanding,
    status,
    overdueDays,
  };
}

function moneyLabel(value: Decimal, currency: Currency): string {
  return formatMoney({ amount: value, currency });
}

/** The remaining balance as a readable amount, for a refusal message. */
function outstandingLabel(statement: RevenueStatement): string {
  return moneyLabel(statement.outstanding, statement.currency);
}

/**
 * Why a payment cannot be recorded, or `null` when it can.
 *
 * An overpayment is refused: inventing a credit balance would make every later
 * figure ambiguous. The message names the explicit path — a credit note — so the
 * owner is never left without a way to correct the invoice.
 */
export function paymentRefusedReason(
  statement: RevenueStatement,
  value: Decimal,
): string | null {
  if (!value.greaterThan(0)) {
    return "Le montant doit être supérieur à zéro.";
  }

  if (value.greaterThan(statement.outstanding)) {
    return `Le montant dépasse le reste dû (${outstandingLabel(statement)}). Un trop-perçu n'est pas accepté : émettez un avoir pour réduire la facture.`;
  }

  return null;
}

/** Why a refund cannot be recorded: it never returns more than was received. */
export function refundRefusedReason(
  statement: RevenueStatement,
  value: Decimal,
): string | null {
  if (!value.greaterThan(0)) {
    return "Le montant doit être supérieur à zéro.";
  }

  if (value.greaterThan(statement.paid)) {
    return `Le remboursement dépasse le montant net encaissé (${moneyLabel(statement.paid, statement.currency)}).`;
  }

  return null;
}

/** Why a write-off cannot be recorded: only the remaining balance can be abandoned. */
export function writeOffRefusedReason(
  statement: RevenueStatement,
  value: Decimal,
): string | null {
  if (!value.greaterThan(0)) {
    return "Le montant doit être supérieur à zéro.";
  }

  if (value.greaterThan(statement.outstanding)) {
    return `La mise en perte dépasse le reste dû (${outstandingLabel(statement)}).`;
  }

  return null;
}

/**
 * Why a credit note cannot be issued, or `null` when it can.
 *
 * A credit note reduces the outstanding balance, never below zero, and cannot be
 * dated before the invoice it corrects.
 */
export function creditNoteRefusedReason(
  statement: RevenueStatement,
  invoiceIssuedOn: Date,
  value: Decimal,
  issuedOn: Date,
): string | null {
  if (!value.greaterThan(0)) {
    return "Le montant doit être supérieur à zéro.";
  }

  if (value.greaterThan(statement.outstanding)) {
    return `L'avoir dépasse le reste dû (${outstandingLabel(statement)}).`;
  }

  if (isBeforeDay(issuedOn, invoiceIssuedOn)) {
    return "La date de l'avoir ne peut pas précéder celle de la facture.";
  }

  return null;
}

const DOCUMENT_BASE_MESSAGE = "Le montant doit être supérieur à zéro.";

const documentFields = z.object({
  kind: z.enum(REVENUE_DOCUMENT_KINDS, "Type de document inconnu."),
  projectId: optionalId,
  creditNoteForId: optionalId,
  amount: amount.refine((value) => value.greaterThan(0), DOCUMENT_BASE_MESSAGE),
  issuedOn: requiredDate,
  dueOn: optionalDate,
  recognizedOn: optionalDate,
  recognizedAmount: optionalAmount.refine(
    (value) => value === null || value.greaterThan(0),
    DOCUMENT_BASE_MESSAGE,
  ),
  notes: optionalText(2000, "Les notes sont limitées à 2000 caractères."),
});

type RevenueDocumentFields = z.infer<typeof documentFields>;

const RECOGNITION_PAIR_MESSAGE =
  "Renseignez la date et le montant de reconnaissance ensemble, ou laissez les deux vides.";
const INVOICE_PROJECT_MESSAGE = "Une facture doit être rattachée à un projet.";
const INVOICE_DUE_MESSAGE = "Une facture doit avoir une échéance.";
const CREDIT_NOTE_TARGET_MESSAGE = "Choisissez la facture que cet avoir réduit.";
const CREDIT_NOTE_DUE_MESSAGE = "Un avoir n'a pas d'échéance de paiement.";
const CREDIT_NOTE_RECOGNITION_MESSAGE =
  "La reconnaissance est portée par la facture ; un avoir n'en porte pas.";
const INVOICE_TARGET_MESSAGE = "Une facture ne se rattache pas à une autre facture.";

/**
 * Input contract for an invoice or a credit note.
 *
 * One schema with conditional rules keeps the form simple: switching the kind shows
 * or hides fields, and the same `superRefine` runs in the browser and on the server.
 * The currency is deliberately absent — it is the project's, read server-side.
 */
export const revenueDocumentInputSchema = documentFields.superRefine(
  (value: RevenueDocumentFields, ctx) => {
    if (value.kind === "INVOICE") {
      if (value.projectId === null) {
        ctx.addIssue({ code: "custom", path: ["projectId"], message: INVOICE_PROJECT_MESSAGE });
      }
      if (value.dueOn === null) {
        ctx.addIssue({ code: "custom", path: ["dueOn"], message: INVOICE_DUE_MESSAGE });
      }
      if (value.creditNoteForId !== null) {
        ctx.addIssue({
          code: "custom",
          path: ["creditNoteForId"],
          message: INVOICE_TARGET_MESSAGE,
        });
      }
    } else {
      if (value.creditNoteForId === null) {
        ctx.addIssue({
          code: "custom",
          path: ["creditNoteForId"],
          message: CREDIT_NOTE_TARGET_MESSAGE,
        });
      }
      if (value.dueOn !== null) {
        ctx.addIssue({
          code: "custom",
          path: ["dueOn"],
          message: CREDIT_NOTE_DUE_MESSAGE,
        });
      }
      if (value.recognizedOn !== null || value.recognizedAmount !== null) {
        ctx.addIssue({
          code: "custom",
          path: ["recognizedOn"],
          message: CREDIT_NOTE_RECOGNITION_MESSAGE,
        });
      }
    }

    if ((value.recognizedOn === null) !== (value.recognizedAmount === null)) {
      ctx.addIssue({
        code: "custom",
        path: ["recognizedAmount"],
        message: RECOGNITION_PAIR_MESSAGE,
      });
    }
  },
);

export type RevenueDocumentInput = z.input<typeof revenueDocumentInputSchema>;
export type ValidatedRevenueDocumentInput = z.output<typeof revenueDocumentInputSchema>;

const MOVEMENT_AMOUNT_MESSAGE = "Le montant doit être supérieur à zéro.";

/** Input contract for a payment, a refund or a write-off. */
export const revenueMovementInputSchema = z.object({
  type: z.enum(REVENUE_MOVEMENT_TYPES, "Type de mouvement inconnu."),
  documentId: z.string().trim().min(1, "Une facture est requise."),
  amount: amount.refine((value) => value.greaterThan(0), MOVEMENT_AMOUNT_MESSAGE),
  date: requiredDate,
  notes: optionalText(2000, "Les notes sont limitées à 2000 caractères."),
});

export type RevenueMovementInput = z.input<typeof revenueMovementInputSchema>;
export type ValidatedRevenueMovementInput = z.output<typeof revenueMovementInputSchema>;

export const REVENUE_MONTH_ENTRY_KINDS = [
  "ISSUED",
  "CREDIT_NOTE",
  "RECOGNIZED",
  "PAYMENT",
  "REFUND",
  "WRITE_OFF",
] as const;

export type RevenueMonthEntryKind = (typeof REVENUE_MONTH_ENTRY_KINDS)[number];

/** One dated movement, flattened for the monthly summary. */
export type RevenueMonthEntry = {
  currency: Currency;
  kind: RevenueMonthEntryKind;
  amount: Decimal;
  date: Date;
};

export type RevenueMonthTotal = {
  currency: Currency;
  /** Invoices issued minus credit notes issued in the month. */
  issued: Decimal;
  /** Recognition snapshots dated in the month. */
  recognized: Decimal;
  /** Payments minus refunds in the month. */
  paid: Decimal;
  writtenOff: Decimal;
};

/**
 * The month's revenue figures, per currency.
 *
 * Only movements dated inside the requested month count. A month with no entry returns
 * an empty list — "no data" is never rendered as a row of zeros. Currencies are never
 * converted.
 */
export function summariseRevenueMonth(
  entries: readonly RevenueMonthEntry[],
  year: number,
  month: number,
): RevenueMonthTotal[] {
  const { start, end } = monthRange(year, month);
  const totals = new Map<Currency, RevenueMonthTotal>();

  for (const entry of entries) {
    if (entry.date.getTime() < start.getTime() || entry.date.getTime() >= end.getTime()) {
      continue;
    }

    const total = totals.get(entry.currency) ?? {
      currency: entry.currency,
      issued: new Decimal(0),
      recognized: new Decimal(0),
      paid: new Decimal(0),
      writtenOff: new Decimal(0),
    };

    switch (entry.kind) {
      case "ISSUED":
        total.issued = total.issued.plus(entry.amount);
        break;
      case "CREDIT_NOTE":
        total.issued = total.issued.minus(entry.amount);
        break;
      case "RECOGNIZED":
        total.recognized = total.recognized.plus(entry.amount);
        break;
      case "PAYMENT":
        total.paid = total.paid.plus(entry.amount);
        break;
      case "REFUND":
        total.paid = total.paid.minus(entry.amount);
        break;
      case "WRITE_OFF":
        total.writtenOff = total.writtenOff.plus(entry.amount);
        break;
    }

    totals.set(entry.currency, total);
  }

  return [...totals.values()].sort((left, right) =>
    left.currency.localeCompare(right.currency),
  );
}

/** Flattens the loaded documents into the entries the monthly summary reads. */
export function revenueMonthEntries(
  documents: readonly RevenueDocumentRecord[],
): RevenueMonthEntry[] {
  return documents.flatMap((document) => {
    const entries: RevenueMonthEntry[] = [
      {
        currency: document.currency,
        kind: document.kind === "INVOICE" ? "ISSUED" : "CREDIT_NOTE",
        amount: document.amount,
        date: document.issuedOn,
      },
    ];

    if (
      document.kind === "INVOICE" &&
      document.recognizedOn !== null &&
      document.recognizedAmount !== null
    ) {
      entries.push({
        currency: document.currency,
        kind: "RECOGNIZED",
        amount: document.recognizedAmount,
        date: document.recognizedOn,
      });
    }

    for (const payment of document.payments) {
      entries.push({
        currency: document.currency,
        kind: "PAYMENT",
        amount: payment.amount,
        date: payment.paidOn,
      });
    }

    for (const refund of document.refunds) {
      entries.push({
        currency: document.currency,
        kind: "REFUND",
        amount: refund.amount,
        date: refund.refundedOn,
      });
    }

    for (const writeOff of document.writeOffs) {
      entries.push({
        currency: document.currency,
        kind: "WRITE_OFF",
        amount: writeOff.amount,
        date: writeOff.writtenOffOn,
      });
    }

    return entries;
  });
}
