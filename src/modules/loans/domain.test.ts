import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import {
  clampPaymentDay,
  groupLoansByCurrency,
  loanInputSchema,
  monthlyInsuranceCost,
  normaliseInsuranceFields,
  resolvePaymentDay,
  toLoanFormValues,
  type LoanSummary,
} from "./domain";

/** Fictitious values only: no real loan or lender ever reaches a fixture. */
const VALID = {
  label: "Prêt auto de test",
  lender: "Banque de test",
  notes: "",
  purpose: "VEHICLE",
  currency: "EUR",
  initialPrincipal: "25 000,00",
  annualRate: "3,45 %",
  termMonths: "60",
  startDate: "2026-01-01",
  firstDueDate: "2026-02-05",
  paymentDay: "",
  interestOnlyMonths: "0",
  insuranceMode: "FIXED_MONTHLY",
  insuranceMonthlyAmount: "25,00",
  insuranceRate: "",
  fees: "250,00",
  propertyId: "",
  outstandingBalance: "20 000,00",
  balanceAsOf: "2026-10-01",
};

function parse(overrides: Record<string, unknown> = {}) {
  return loanInputSchema.safeParse({ ...VALID, ...overrides });
}

function loan(overrides: Partial<LoanSummary> = {}): LoanSummary {
  return {
    id: "loan-1",
    label: "Prêt de test",
    lender: null,
    notes: null,
    purpose: "CONSUMER",
    currency: "EUR",
    initialPrincipal: new Decimal("250000.00"),
    annualRate: new Decimal("3.45"),
    termMonths: 240,
    startDate: null,
    firstDueDate: null,
    paymentDay: 5,
    interestOnlyMonths: 0,
    insuranceMode: "NONE",
    insuranceMonthlyAmount: null,
    insuranceRate: null,
    fees: null,
    propertyId: null,
    propertyName: null,
    outstandingBalance: null,
    balanceAsOf: null,
    archived: false,
    archivedAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("loanInputSchema", () => {
  it("accepts a nominal loan and normalises the French decimal rate", () => {
    const parsed = parse();

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    expect(parsed.data.initialPrincipal.toFixed(2)).toBe("25000.00");
    expect(parsed.data.annualRate?.toFixed(4)).toBe("3.4500");
    expect(parsed.data.fees?.toFixed(2)).toBe("250.00");
    expect(parsed.data.outstandingBalance?.toFixed(2)).toBe("20000.00");
    expect(parsed.data.termMonths).toBe(60);
    expect(parsed.data.interestOnlyMonths).toBe(0);
    expect(parsed.data.propertyId).toBeNull();
  });

  it("defaults the currency to EUR when the payload omits it", () => {
    const parsed = loanInputSchema.safeParse({ ...VALID, currency: undefined });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.currency).toBe("EUR");
    }
  });

  it("keeps an unknown insurance null, distinct from an explicit no-insurance", () => {
    const unknown = parse({
      insuranceMode: "",
      insuranceMonthlyAmount: "",
      insuranceRate: "",
    });
    expect(unknown.success).toBe(true);
    if (unknown.success) {
      expect(unknown.data.insuranceMode).toBeNull();
    }

    const none = parse({
      insuranceMode: "NONE",
      insuranceMonthlyAmount: "",
      insuranceRate: "",
    });
    expect(none.success).toBe(true);
    if (none.success) {
      expect(none.data.insuranceMode).toBe("NONE");
    }
  });

  it("keeps every missing optional figure null rather than zero", () => {
    const parsed = parse({
      annualRate: "",
      termMonths: "",
      insuranceMode: "NONE",
      insuranceMonthlyAmount: "",
      fees: "",
      outstandingBalance: "",
      balanceAsOf: "",
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    expect(parsed.data.annualRate).toBeNull();
    expect(parsed.data.termMonths).toBeNull();
    expect(parsed.data.insuranceMonthlyAmount).toBeNull();
    expect(parsed.data.insuranceRate).toBeNull();
    expect(parsed.data.fees).toBeNull();
    expect(parsed.data.outstandingBalance).toBeNull();
    expect(parsed.data.balanceAsOf).toBeNull();
    expect(parsed.data.interestOnlyMonths).toBe(0);
  });

  it("rejects a zero or negative principal", () => {
    expect(parse({ initialPrincipal: "0,00" }).success).toBe(false);
    expect(parse({ initialPrincipal: "-1,00" }).success).toBe(false);
  });

  it("keeps four decimals of rate and rejects more", () => {
    const precise = parse({ annualRate: "3,4567" });
    expect(precise.success).toBe(true);
    if (precise.success) {
      expect(precise.data.annualRate?.toFixed(4)).toBe("3.4567");
    }

    expect(parse({ annualRate: "3,45678" }).success).toBe(false);
  });

  it("rejects a rate above 100 % and a negative rate", () => {
    expect(parse({ annualRate: "100" }).success).toBe(true);
    expect(parse({ annualRate: "100,01" }).success).toBe(false);
    expect(parse({ annualRate: "-0,01" }).success).toBe(false);
  });

  it("rejects an invalid payment day", () => {
    expect(parse({ paymentDay: "0" }).success).toBe(false);
    expect(parse({ paymentDay: "32" }).success).toBe(false);
    expect(parse({ paymentDay: "abc" }).success).toBe(false);
    expect(parse({ paymentDay: "31" }).success).toBe(true);
  });

  it("rejects a non-positive or out-of-range term", () => {
    expect(parse({ termMonths: "0" }).success).toBe(false);
    expect(parse({ termMonths: "601" }).success).toBe(false);
    expect(parse({ termMonths: "12,5" }).success).toBe(false);
  });

  it("requires a balance and its observation date together", () => {
    const missingDate = parse({ outstandingBalance: "1000,00", balanceAsOf: "" });
    expect(missingDate.success).toBe(false);

    const missingAmount = parse({ outstandingBalance: "", balanceAsOf: "2026-10-01" });
    expect(missingAmount.success).toBe(false);

    // A fully repaid loan has a genuine zero balance, distinct from "not recorded".
    expect(parse({ outstandingBalance: "0,00", balanceAsOf: "2026-10-01" }).success).toBe(
      true,
    );
  });

  it("requires the figure the chosen insurance mode uses", () => {
    expect(
      parse({
        insuranceMode: "FIXED_MONTHLY",
        insuranceMonthlyAmount: "",
        insuranceRate: "",
      }).success,
    ).toBe(false);

    expect(
      parse({
        insuranceMode: "RATE_OF_PRINCIPAL",
        insuranceMonthlyAmount: "",
        insuranceRate: "",
      }).success,
    ).toBe(false);

    expect(
      parse({
        insuranceMode: "RATE_OF_BALANCE",
        insuranceMonthlyAmount: "",
        insuranceRate: "0,35",
      }).success,
    ).toBe(true);
  });

  it("rejects a deferral that is not shorter than the term", () => {
    expect(parse({ termMonths: "60", interestOnlyMonths: "60" }).success).toBe(false);
    expect(parse({ termMonths: "60", interestOnlyMonths: "59" }).success).toBe(true);
  });

  it("rejects a first due date before the start date", () => {
    expect(
      parse({ startDate: "2026-02-01", firstDueDate: "2026-01-31" }).success,
    ).toBe(false);
  });
});

describe("normaliseInsuranceFields", () => {
  const amount = new Decimal("25.00");
  const rate = new Decimal("0.35");

  it("drops the figure the chosen mode does not use", () => {
    expect(
      normaliseInsuranceFields({
        insuranceMode: null,
        insuranceMonthlyAmount: amount,
        insuranceRate: rate,
      }),
    ).toEqual({ insuranceMonthlyAmount: null, insuranceRate: null });

    expect(
      normaliseInsuranceFields({
        insuranceMode: "NONE",
        insuranceMonthlyAmount: amount,
        insuranceRate: rate,
      }),
    ).toEqual({ insuranceMonthlyAmount: null, insuranceRate: null });

    expect(
      normaliseInsuranceFields({
        insuranceMode: "FIXED_MONTHLY",
        insuranceMonthlyAmount: amount,
        insuranceRate: rate,
      }),
    ).toEqual({ insuranceMonthlyAmount: amount, insuranceRate: null });

    expect(
      normaliseInsuranceFields({
        insuranceMode: "RATE_OF_PRINCIPAL",
        insuranceMonthlyAmount: amount,
        insuranceRate: rate,
      }),
    ).toEqual({ insuranceMonthlyAmount: null, insuranceRate: rate });
  });
});

describe("monthlyInsuranceCost", () => {
  it("leaves an unrecorded insurance unknown, never zero", () => {
    expect(monthlyInsuranceCost(loan({ insuranceMode: null }))).toBeNull();
  });

  it("reads an explicit no-insurance as zero", () => {
    expect(monthlyInsuranceCost(loan({ insuranceMode: "NONE" }))?.toFixed(2)).toBe("0.00");
  });

  it("returns the fixed monthly amount", () => {
    const cost = monthlyInsuranceCost(
      loan({ insuranceMode: "FIXED_MONTHLY", insuranceMonthlyAmount: new Decimal("45.00") }),
    );
    expect(cost?.toFixed(2)).toBe("45.00");
  });

  it("applies a rate of principal to the borrowed amount", () => {
    const cost = monthlyInsuranceCost(
      loan({
        insuranceMode: "RATE_OF_PRINCIPAL",
        insuranceRate: new Decimal("0.35"),
        initialPrincipal: new Decimal("250000.00"),
      }),
    );
    expect(cost?.toFixed(2)).toBe("72.92");
  });

  it("never invents a cost for a rate of balance without a balance", () => {
    expect(
      monthlyInsuranceCost(
        loan({
          insuranceMode: "RATE_OF_BALANCE",
          insuranceRate: new Decimal("0.35"),
          outstandingBalance: null,
        }),
      ),
    ).toBeNull();
  });

  it("applies a rate of balance to the recorded snapshot", () => {
    const cost = monthlyInsuranceCost(
      loan({
        insuranceMode: "RATE_OF_BALANCE",
        insuranceRate: new Decimal("0.35"),
        outstandingBalance: new Decimal("198500.00"),
      }),
    );
    expect(cost?.toFixed(2)).toBe("57.90");
  });
});

describe("groupLoansByCurrency", () => {
  it("groups by currency, active first, without any cross-currency total", () => {
    const groups = groupLoansByCurrency([
      loan({ id: "eur-archived", label: "B", archived: true, archivedAt: new Date() }),
      loan({ id: "eur-active", label: "A" }),
      loan({ id: "usd", label: "C", currency: "USD" }),
    ]);

    expect(groups.map((group) => group.currency)).toEqual(["EUR", "USD"]);
    expect(groups[0].loans.map((entry) => entry.id)).toEqual(["eur-active", "eur-archived"]);
    expect(groups[0]).toMatchObject({ activeCount: 1, archivedCount: 1 });
    expect(groups[1]).toMatchObject({ activeCount: 1, archivedCount: 0 });
  });
});

describe("payment day helpers", () => {
  it("clamps the 31st to the last day of a short month", () => {
    expect(clampPaymentDay(2026, 2, 31)).toBe(28);
    expect(clampPaymentDay(2028, 2, 31)).toBe(29);
    expect(clampPaymentDay(2026, 4, 31)).toBe(30);
    expect(clampPaymentDay(2026, 1, 31)).toBe(31);
  });

  it("derives the payment day from the first due date when it was left empty", () => {
    expect(resolvePaymentDay(new Date("2026-02-05T00:00:00.000Z"), null)).toBe(5);
    expect(resolvePaymentDay(null, 12)).toBe(12);
    expect(resolvePaymentDay(null, null)).toBeNull();
    expect(resolvePaymentDay(new Date("2026-02-05T00:00:00.000Z"), 20)).toBe(20);
  });
});

describe("toLoanFormValues", () => {
  it("serialises amounts and dates for the client, keeping unknown values empty", () => {
    const values = toLoanFormValues(
      loan({
        annualRate: null,
        termMonths: null,
        startDate: new Date("2026-01-01T00:00:00.000Z"),
        firstDueDate: null,
        paymentDay: null,
        outstandingBalance: null,
        balanceAsOf: null,
      }),
    );

    expect(values.initialPrincipal).toBe("250000.00");
    expect(values.annualRate).toBe("");
    expect(values.termMonths).toBe("");
    expect(values.startDate).toBe("2026-01-01");
    expect(values.paymentDay).toBe("");
    expect(values.balanceAsOf).toBe("");
  });
});
