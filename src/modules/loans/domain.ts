import Decimal from "decimal.js";
import { z } from "zod";
import { toDateOnlyString } from "@/lib/dates";
import { type Currency } from "@/lib/money";
import {
  amount,
  currencyCode,
  optionalAmount,
  optionalDate,
  optionalId,
  optionalInt,
  optionalRate,
  optionalText,
} from "@/lib/validation";

/**
 * The workspace loan registry (M21-01).
 *
 * A loan is a record of the terms the owner knows: a mortgage, a car loan, a consumer
 * credit, a student loan or a business loan. Nothing here computes an amortisation
 * schedule (M21-02), simulates a scenario (M21-04) or matches a bank account (M21-03).
 *
 * Two rules run through the whole module:
 * - a missing rate, term, insurance or balance is **not recorded**, never zero;
 * - amounts are exact decimals in one explicit currency, and currencies are never
 *   converted or summed together.
 */

export const LOAN_PURPOSES = [
  "MORTGAGE",
  "VEHICLE",
  "CONSUMER",
  "STUDENT",
  "BUSINESS",
  "REAL_ESTATE_INVESTMENT",
  "OTHER",
] as const;

export type LoanPurpose = (typeof LOAN_PURPOSES)[number];

export const LOAN_PURPOSE_LABELS: Record<LoanPurpose, string> = {
  MORTGAGE: "Crédit immobilier",
  VEHICLE: "Crédit automobile",
  CONSUMER: "Crédit à la consommation",
  STUDENT: "Prêt étudiant",
  BUSINESS: "Prêt professionnel",
  REAL_ESTATE_INVESTMENT: "Investissement locatif",
  OTHER: "Autre",
};

export const LOAN_INSURANCE_MODES = [
  "NONE",
  "FIXED_MONTHLY",
  "RATE_OF_PRINCIPAL",
  "RATE_OF_BALANCE",
] as const;

export type LoanInsuranceMode = (typeof LOAN_INSURANCE_MODES)[number];

export const LOAN_INSURANCE_MODE_LABELS: Record<LoanInsuranceMode, string> = {
  NONE: "Aucune assurance",
  FIXED_MONTHLY: "Montant mensuel fixe",
  RATE_OF_PRINCIPAL: "Pourcentage du capital",
  RATE_OF_BALANCE: "Pourcentage du solde restant",
};

/** A recorded loan, with its property name when one is linked. */
export type LoanSummary = {
  id: string;
  label: string;
  lender: string | null;
  notes: string | null;
  purpose: LoanPurpose;
  currency: Currency;
  /** Positive magnitude: the amount borrowed. */
  initialPrincipal: Decimal;
  /** Annual percentage; `null` = not recorded. */
  annualRate: Decimal | null;
  /** Whole months; `null` = not recorded. */
  termMonths: number | null;
  startDate: Date | null;
  firstDueDate: Date | null;
  /** 1–31, or `null` = not recorded. */
  paymentDay: number | null;
  interestOnlyMonths: number;
  /** `null` = insurance not recorded; `NONE` = explicit no-insurance. */
  insuranceMode: LoanInsuranceMode | null;
  insuranceMonthlyAmount: Decimal | null;
  insuranceRate: Decimal | null;
  fees: Decimal | null;
  propertyId: string | null;
  propertyName: string | null;
  /** Manual snapshot; `null` = not recorded. */
  outstandingBalance: Decimal | null;
  balanceAsOf: Date | null;
  archived: boolean;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Everything the repository writes, after the service resolved the optional link. */
export type LoanWriteInput = {
  label: string;
  lender: string | null;
  notes: string | null;
  purpose: LoanPurpose;
  currency: Currency;
  initialPrincipal: Decimal;
  annualRate: Decimal | null;
  termMonths: number | null;
  startDate: Date | null;
  firstDueDate: Date | null;
  paymentDay: number | null;
  interestOnlyMonths: number;
  insuranceMode: LoanInsuranceMode | null;
  insuranceMonthlyAmount: Decimal | null;
  insuranceRate: Decimal | null;
  fees: Decimal | null;
  propertyId: string | null;
  outstandingBalance: Decimal | null;
  balanceAsOf: Date | null;
};

/** Longest term the form accepts: fifty years. A count, never a decimal. */
export const MAX_TERM_MONTHS = 600;

const POSITIVE_MESSAGE = "La valeur doit être supérieure à zéro.";
const NON_NEGATIVE_MESSAGE = "La valeur ne peut pas être négative.";
const RATE_RANGE_MESSAGE = "Le taux doit être compris entre 0 et 100 %.";
const TERM_MESSAGE = `La durée doit être un nombre entier de mois compris entre 1 et ${MAX_TERM_MONTHS}.`;
const PAYMENT_DAY_MESSAGE = "Le jour de paiement doit être compris entre 1 et 31.";
const INSURANCE_AMOUNT_MESSAGE =
  "Renseignez le montant mensuel d'assurance, ou choisissez « Aucune assurance ».";
const INSURANCE_RATE_MESSAGE =
  "Renseignez le taux d'assurance, ou choisissez « Aucune assurance ».";
const BALANCE_MESSAGE =
  "Un solde doit être daté : renseignez le montant et sa date ensemble, ou laissez les deux vides.";
const DATES_MESSAGE = "La première échéance ne peut pas précéder la date de début.";
const DEFERRAL_MESSAGE = "La période de différé doit être inférieure à la durée totale.";

const nonNegative = optionalAmount.refine(
  (value) => value === null || value.greaterThanOrEqualTo(0),
  NON_NEGATIVE_MESSAGE,
);
const optionalBoundedRate = optionalRate.refine(
  (value) =>
    value === null || (value.greaterThanOrEqualTo(0) && value.lessThanOrEqualTo(100)),
  RATE_RANGE_MESSAGE,
);

/**
 * The editable fields of a loan.
 *
 * The client form and the Server Action share this schema. The server parses again:
 * a value displayed in the browser is a comfort, never an authorisation, and the
 * French decimal input ("3,45 %") is normalised here.
 */
const loanFields = z.object({
  label: z
    .string()
    .trim()
    .min(1, "Le libellé est requis.")
    .max(120, "Le libellé est limité à 120 caractères."),
  lender: optionalText(160, "Le prêteur est limité à 160 caractères."),
  notes: optionalText(2000, "Les notes sont limitées à 2000 caractères."),
  purpose: z.enum(LOAN_PURPOSES, "Objet du prêt inconnu."),
  currency: currencyCode.default("EUR"),
  initialPrincipal: amount.refine(
    (value) => value.greaterThan(0),
    "Le capital initial doit être supérieur à zéro.",
  ),
  annualRate: optionalBoundedRate,
  termMonths: optionalInt.refine(
    (value) =>
      value === null ||
      (Number.isInteger(value) && value >= 1 && value <= MAX_TERM_MONTHS),
    TERM_MESSAGE,
  ),
  startDate: optionalDate,
  firstDueDate: optionalDate,
  paymentDay: optionalInt.refine(
    (value) => value === null || (value >= 1 && value <= 31),
    PAYMENT_DAY_MESSAGE,
  ),
  interestOnlyMonths: optionalInt
    .refine(
      (value) => value === null || (value >= 0 && value <= MAX_TERM_MONTHS),
      `La période de différé doit être comprise entre 0 et ${MAX_TERM_MONTHS} mois.`,
    )
    .transform((value) => value ?? 0),
  insuranceMode: z
    .union([
      z.literal(""),
      z.enum(LOAN_INSURANCE_MODES, "Mode d'assurance inconnu."),
    ])
    .nullish()
    .transform((value) => (value === "" || value === null || value === undefined ? null : value)),
  insuranceMonthlyAmount: optionalAmount.refine(
    (value) => value === null || value.greaterThan(0),
    POSITIVE_MESSAGE,
  ),
  insuranceRate: optionalBoundedRate,
  fees: nonNegative,
  propertyId: optionalId,
  outstandingBalance: nonNegative,
  balanceAsOf: optionalDate,
});

type LoanFields = z.infer<typeof loanFields>;

/** The rules no single field can see. */
function loanRules(value: LoanFields, ctx: z.RefinementCtx): void {
  if (value.insuranceMode === "FIXED_MONTHLY" && value.insuranceMonthlyAmount === null) {
    ctx.addIssue({
      code: "custom",
      message: INSURANCE_AMOUNT_MESSAGE,
      path: ["insuranceMonthlyAmount"],
    });
  }

  if (
    (value.insuranceMode === "RATE_OF_PRINCIPAL" ||
      value.insuranceMode === "RATE_OF_BALANCE") &&
    value.insuranceRate === null
  ) {
    ctx.addIssue({
      code: "custom",
      message: INSURANCE_RATE_MESSAGE,
      path: ["insuranceRate"],
    });
  }

  if (Boolean(value.outstandingBalance) !== Boolean(value.balanceAsOf)) {
    ctx.addIssue({
      code: "custom",
      message: BALANCE_MESSAGE,
      path: ["balanceAsOf"],
    });
  }

  if (
    value.startDate &&
    value.firstDueDate &&
    value.firstDueDate.getTime() < value.startDate.getTime()
  ) {
    ctx.addIssue({
      code: "custom",
      message: DATES_MESSAGE,
      path: ["firstDueDate"],
    });
  }

  if (value.termMonths !== null && value.interestOnlyMonths >= value.termMonths) {
    ctx.addIssue({
      code: "custom",
      message: DEFERRAL_MESSAGE,
      path: ["interestOnlyMonths"],
    });
  }
}

export const loanInputSchema = loanFields.superRefine(loanRules);

export type LoanInput = z.input<typeof loanInputSchema>;
export type ValidatedLoanInput = z.output<typeof loanInputSchema>;

/** Same rules plus the identifier, for an in-place edit. */
export const loanUpdateSchema = loanFields
  .extend({ id: z.string().trim().min(1, "Identifiant manquant.") })
  .superRefine(loanRules);

export type LoanUpdateInput = z.input<typeof loanUpdateSchema>;
export type ValidatedLoanUpdateInput = z.output<typeof loanUpdateSchema>;

/**
 * Drops the insurance figures the chosen mode does not use.
 *
 * Switching from a fixed monthly amount to a rate (or back) must not leave a stale
 * figure behind that a later computation could read as meaningful.
 */
export function normaliseInsuranceFields(input: {
  insuranceMode: LoanInsuranceMode | null;
  insuranceMonthlyAmount: Decimal | null;
  insuranceRate: Decimal | null;
}): { insuranceMonthlyAmount: Decimal | null; insuranceRate: Decimal | null } {
  switch (input.insuranceMode) {
    case null:
    case "NONE":
      return { insuranceMonthlyAmount: null, insuranceRate: null };
    case "FIXED_MONTHLY":
      return {
        insuranceMonthlyAmount: input.insuranceMonthlyAmount,
        insuranceRate: null,
      };
    default:
      return {
        insuranceMonthlyAmount: null,
        insuranceRate: input.insuranceRate,
      };
  }
}

/**
 * The day of the month a loan is paid, when it is not typed explicitly: the day of
 * the first due date. `null` stays `null` — nothing recorded is not the 1st.
 */
export function resolvePaymentDay(
  firstDueDate: Date | null,
  paymentDay: number | null,
): number | null {
  if (paymentDay !== null) {
    return paymentDay;
  }

  return firstDueDate ? firstDueDate.getUTCDate() : null;
}

/**
 * A payment day brought back inside a month: the 31st becomes 28/29 in February and
 * 30 in April. Exposed for the schedule computations M21-02 will build on.
 */
export function clampPaymentDay(
  year: number,
  month: number,
  paymentDay: number,
): number {
  if (!Number.isInteger(paymentDay) || paymentDay < 1 || paymentDay > 31) {
    throw new RangeError(`Invalid payment day: ${paymentDay}`);
  }

  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return Math.min(paymentDay, lastDay);
}

/**
 * The monthly cost of the insurance, or `null` when it cannot be derived.
 *
 * - `NONE` is an explicit zero: the owner said there is no insurance.
 * - a `null` mode means "not recorded": the cost is unknown, never zero.
 * - `FIXED_MONTHLY` reads the recorded amount, or `null` when it is missing.
 * - `RATE_OF_PRINCIPAL` applies the annual percentage to the borrowed principal.
 * - `RATE_OF_BALANCE` applies it to the recorded balance snapshot; without a balance
 *   the cost is unknown, never zero.
 */
export function monthlyInsuranceCost(
  loan: Pick<
    LoanSummary,
    | "insuranceMode"
    | "insuranceMonthlyAmount"
    | "insuranceRate"
    | "initialPrincipal"
    | "outstandingBalance"
  >,
): Decimal | null {
  switch (loan.insuranceMode) {
    case null:
      return null;
    case "NONE":
      return new Decimal(0);
    case "FIXED_MONTHLY":
      return loan.insuranceMonthlyAmount === null
        ? null
        : loan.insuranceMonthlyAmount.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    case "RATE_OF_PRINCIPAL":
      return loan.insuranceRate === null
        ? null
        : loan.initialPrincipal
            .times(loan.insuranceRate)
            .dividedBy(100)
            .dividedBy(12)
            .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    case "RATE_OF_BALANCE":
      if (loan.insuranceRate === null || loan.outstandingBalance === null) {
        return null;
      }
      return loan.outstandingBalance
        .times(loan.insuranceRate)
        .dividedBy(100)
        .dividedBy(12)
        .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  }
}

export type LoanCurrencyGroup = {
  currency: Currency;
  loans: LoanSummary[];
  activeCount: number;
  archivedCount: number;
};

/**
 * Groups loans by currency, active first then by label inside each group.
 *
 * A group is the only place a figure may be added up: there is deliberately no
 * cross-currency total, because that one would need an exchange rate this module
 * refuses to guess.
 */
export function groupLoansByCurrency(loans: readonly LoanSummary[]): LoanCurrencyGroup[] {
  const groups = new Map<Currency, LoanSummary[]>();

  for (const loan of loans) {
    const group = groups.get(loan.currency) ?? [];
    group.push(loan);
    groups.set(loan.currency, group);
  }

  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, currencyLoans]) => {
      const sorted = [...currencyLoans].sort(
        (left, right) =>
          Number(left.archived) - Number(right.archived) ||
          left.label.localeCompare(right.label, "fr") ||
          left.id.localeCompare(right.id),
      );

      return {
        currency,
        loans: sorted,
        activeCount: sorted.filter((loan) => !loan.archived).length,
        archivedCount: sorted.filter((loan) => loan.archived).length,
      };
    });
}

/** A truncated decimal for an edit field: no trailing zeros, at most four decimals. */
function rateInputValue(value: Decimal | null): string {
  return value === null ? "" : value.toFixed(4).replace(/\.?0+$/, "");
}

/** The loan reduced to strings for the client form: no Decimal or Date crosses over. */
export type LoanFormValues = {
  id: string;
  label: string;
  lender: string;
  notes: string;
  purpose: LoanPurpose;
  currency: string;
  initialPrincipal: string;
  annualRate: string;
  termMonths: string;
  startDate: string;
  firstDueDate: string;
  paymentDay: string;
  interestOnlyMonths: string;
  insuranceMode: LoanInsuranceMode | "";
  insuranceMonthlyAmount: string;
  insuranceRate: string;
  fees: string;
  propertyId: string;
  outstandingBalance: string;
  balanceAsOf: string;
};

export function toLoanFormValues(loan: LoanSummary): LoanFormValues {
  return {
    id: loan.id,
    label: loan.label,
    lender: loan.lender ?? "",
    notes: loan.notes ?? "",
    purpose: loan.purpose,
    currency: loan.currency,
    initialPrincipal: loan.initialPrincipal.toFixed(2),
    annualRate: rateInputValue(loan.annualRate),
    termMonths: loan.termMonths === null ? "" : String(loan.termMonths),
    startDate: loan.startDate ? toDateOnlyString(loan.startDate) : "",
    firstDueDate: loan.firstDueDate ? toDateOnlyString(loan.firstDueDate) : "",
    paymentDay: loan.paymentDay === null ? "" : String(loan.paymentDay),
    interestOnlyMonths: String(loan.interestOnlyMonths),
    insuranceMode: loan.insuranceMode ?? "",
    insuranceMonthlyAmount:
      loan.insuranceMonthlyAmount === null ? "" : loan.insuranceMonthlyAmount.toFixed(2),
    insuranceRate: rateInputValue(loan.insuranceRate),
    fees: loan.fees === null ? "" : loan.fees.toFixed(2),
    propertyId: loan.propertyId ?? "",
    outstandingBalance:
      loan.outstandingBalance === null ? "" : loan.outstandingBalance.toFixed(2),
    balanceAsOf: loan.balanceAsOf ? toDateOnlyString(loan.balanceAsOf) : "",
  };
}
