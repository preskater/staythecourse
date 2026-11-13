import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { parseDateOnly } from "@/lib/dates";
import {
  creditNoteRefusedReason,
  paymentRefusedReason,
  refundRefusedReason,
  revenueDocumentInputSchema,
  revenueMonthEntries,
  statementOf,
  summariseRevenueMonth,
  writeOffRefusedReason,
  type RevenueDocumentRecord,
  type RevenueMonthEntry,
} from "./revenue";

function day(value: string): Date {
  return parseDateOnly(value);
}

const asOf = day("2026-11-10");

/** A valid invoice; each test changes only the rows it is about. */
function invoice(overrides: Partial<RevenueDocumentRecord> = {}): RevenueDocumentRecord {
  return {
    id: "invoice-1",
    kind: "INVOICE",
    projectId: "project-1",
    projectName: "Refonte",
    clientId: "client-1",
    clientName: "Studio Lumen",
    currency: "EUR",
    amount: new Decimal("1000.00"),
    issuedOn: day("2026-11-01"),
    dueOn: day("2026-11-30"),
    recognizedOn: day("2026-11-01"),
    recognizedAmount: new Decimal("1000.00"),
    notes: null,
    creditNoteFor: null,
    creditedBy: [],
    payments: [],
    refunds: [],
    writeOffs: [],
    ...overrides,
  };
}

function payment(amount: string, paidOn = "2026-11-05") {
  return { id: `payment-${amount}-${paidOn}`, amount: new Decimal(amount), paidOn: day(paidOn) };
}

function refund(amount: string, refundedOn = "2026-11-06") {
  return {
    id: `refund-${amount}-${refundedOn}`,
    amount: new Decimal(amount),
    refundedOn: day(refundedOn),
  };
}

function writeOff(amount: string, writtenOffOn = "2026-11-07") {
  return {
    id: `write-off-${amount}-${writtenOffOn}`,
    amount: new Decimal(amount),
    writtenOffOn: day(writtenOffOn),
  };
}

function creditNote(amount: string, issuedOn = "2026-11-08") {
  return { id: `credit-note-${amount}-${issuedOn}`, amount: new Decimal(amount), issuedOn: day(issuedOn) };
}

describe("statementOf", () => {
  it("reads an untouched invoice as open, with the full amount outstanding", () => {
    const statement = statementOf(invoice(), asOf);

    expect(statement.paid.toFixed(2)).toBe("0.00");
    expect(statement.outstanding.toFixed(2)).toBe("1000.00");
    expect(statement.status).toBe("OPEN");
    expect(statement.overdueDays).toBe(0);
  });

  it("sums partial payments and keeps the remaining balance", () => {
    const statement = statementOf(
      invoice({ payments: [payment("300.00"), payment("250.00", "2026-11-08")] }),
      asOf,
    );

    expect(statement.paymentsTotal.toFixed(2)).toBe("550.00");
    expect(statement.paid.toFixed(2)).toBe("550.00");
    expect(statement.outstanding.toFixed(2)).toBe("450.00");
    expect(statement.status).toBe("PARTIALLY_PAID");
  });

  it("reads fully paid once the payments cover the invoice", () => {
    const statement = statementOf(
      invoice({ payments: [payment("400.00"), payment("600.00", "2026-11-09")] }),
      asOf,
    );

    expect(statement.outstanding.toFixed(2)).toBe("0.00");
    expect(statement.status).toBe("PAID");
  });

  it("does not call an invoice overdue on its due day", () => {
    const dueDay = statementOf(invoice(), day("2026-11-30"));

    expect(dueDay.status).toBe("OPEN");
    expect(dueDay.overdueDays).toBe(0);
  });

  it("calls it overdue the next day and counts whole days", () => {
    const statement = statementOf(invoice(), day("2026-12-01"));

    expect(statement.status).toBe("OVERDUE");
    expect(statement.overdueDays).toBe(1);
  });

  it("counts overdue days across a month boundary", () => {
    const statement = statementOf(
      invoice({ dueOn: day("2026-10-31") }),
      day("2026-11-10"),
    );

    expect(statement.overdueDays).toBe(10);
  });

  it("keeps a partly paid invoice overdue once its due day has passed", () => {
    const statement = statementOf(
      invoice({ payments: [payment("100.00")] }),
      day("2026-12-02"),
    );

    expect(statement.status).toBe("OVERDUE");
    expect(statement.paid.toFixed(2)).toBe("100.00");
    expect(statement.outstanding.toFixed(2)).toBe("900.00");
  });

  it("reduces the net received by refunds and reopens the balance", () => {
    const paid = statementOf(
      invoice({ payments: [payment("1000.00")] }),
      asOf,
    );
    expect(paid.status).toBe("PAID");

    const refunded = statementOf(
      invoice({ payments: [payment("1000.00")], refunds: [refund("250.00")] }),
      asOf,
    );

    expect(refunded.paid.toFixed(2)).toBe("750.00");
    expect(refunded.outstanding.toFixed(2)).toBe("250.00");
    expect(refunded.status).toBe("PARTIALLY_PAID");
  });

  it("reduces the issued amount with an explicit credit note", () => {
    const statement = statementOf(
      invoice({ creditedBy: [creditNote("200.00")] }),
      asOf,
    );

    expect(statement.credited.toFixed(2)).toBe("200.00");
    expect(statement.netIssued.toFixed(2)).toBe("800.00");
    expect(statement.outstanding.toFixed(2)).toBe("800.00");
  });

  it("reads a fully credited, unpaid invoice as credited", () => {
    const statement = statementOf(
      invoice({ creditedBy: [creditNote("1000.00")] }),
      asOf,
    );

    expect(statement.netIssued.toFixed(2)).toBe("0.00");
    expect(statement.outstanding.toFixed(2)).toBe("0.00");
    expect(statement.status).toBe("CREDITED");
  });

  it("reads a written-off balance as written off, not paid", () => {
    const statement = statementOf(
      invoice({ writeOffs: [writeOff("1000.00")] }),
      asOf,
    );

    expect(statement.outstanding.toFixed(2)).toBe("0.00");
    expect(statement.status).toBe("WRITTEN_OFF");
  });

  it("keeps the distinction between a payment and a write-off when both settle", () => {
    const statement = statementOf(
      invoice({ payments: [payment("400.00")], writeOffs: [writeOff("600.00")] }),
      asOf,
    );

    expect(statement.outstanding.toFixed(2)).toBe("0.00");
    expect(statement.status).toBe("WRITTEN_OFF");
  });
});

describe("movement refusals", () => {
  it("refuses a payment above the outstanding balance and explains the credit-note path", () => {
    const statement = statementOf(invoice(), asOf);

    expect(paymentRefusedReason(statement, new Decimal("1000.00"))).toBeNull();
    const refusal = paymentRefusedReason(statement, new Decimal("1000.01"));

    expect(refusal).toContain("dépasse le reste dû");
    expect(refusal).toContain("avoir");
  });

  it("refuses a payment of zero or a negative amount", () => {
    const statement = statementOf(invoice(), asOf);

    expect(paymentRefusedReason(statement, new Decimal(0))).toBeTruthy();
    expect(paymentRefusedReason(statement, new Decimal("-1"))).toBeTruthy();
  });

  it("refuses a refund above the net received", () => {
    const statement = statementOf(invoice({ payments: [payment("300.00")] }), asOf);

    expect(refundRefusedReason(statement, new Decimal("300.00"))).toBeNull();
    expect(refundRefusedReason(statement, new Decimal("300.01"))).toContain(
      "dépasse le montant net encaissé",
    );
  });

  it("refuses a refund when nothing was received", () => {
    const statement = statementOf(invoice(), asOf);

    expect(refundRefusedReason(statement, new Decimal("10.00"))).toBeTruthy();
  });

  it("refuses a write-off above the outstanding balance", () => {
    const statement = statementOf(
      invoice({ payments: [payment("250.00")] }),
      asOf,
    );

    expect(writeOffRefusedReason(statement, new Decimal("750.00"))).toBeNull();
    expect(writeOffRefusedReason(statement, new Decimal("750.01"))).toContain(
      "dépasse le reste dû",
    );
  });

  it("refuses a credit note above the outstanding balance", () => {
    const document = invoice({ payments: [payment("200.00")] });
    const statement = statementOf(document, asOf);

    expect(
      creditNoteRefusedReason(statement, document.issuedOn, new Decimal("800.00"), asOf),
    ).toBeNull();
    expect(
      creditNoteRefusedReason(statement, document.issuedOn, new Decimal("800.01"), asOf),
    ).toContain("dépasse le reste dû");
  });

  it("refuses a credit note dated before its invoice", () => {
    const document = invoice();
    const statement = statementOf(document, asOf);

    expect(
      creditNoteRefusedReason(
        statement,
        document.issuedOn,
        new Decimal("100.00"),
        day("2026-10-31"),
      ),
    ).toContain("ne peut pas précéder");
  });

  it("accepts a credit note dated the same day as the invoice", () => {
    const document = invoice();
    const statement = statementOf(document, asOf);

    expect(
      creditNoteRefusedReason(
        statement,
        document.issuedOn,
        new Decimal("100.00"),
        document.issuedOn,
      ),
    ).toBeNull();
  });
});

describe("summariseRevenueMonth", () => {
  const entry = (
    kind: RevenueMonthEntry["kind"],
    value: string,
    date: string,
    currency: RevenueMonthEntry["currency"] = "EUR",
  ): RevenueMonthEntry => ({
    kind,
    amount: new Decimal(value),
    date: day(date),
    currency,
  });

  it("returns no row for a month without data", () => {
    expect(summariseRevenueMonth([], 2026, 11)).toEqual([]);
    expect(
      summariseRevenueMonth([entry("PAYMENT", "100.00", "2026-10-31")], 2026, 11),
    ).toEqual([]);
  });

  it("sums issued, recognized, paid and written-off movements in the month", () => {
    const totals = summariseRevenueMonth(
      [
        entry("ISSUED", "1000.00", "2026-11-01"),
        entry("CREDIT_NOTE", "200.00", "2026-11-05"),
        entry("RECOGNIZED", "800.00", "2026-11-01"),
        entry("PAYMENT", "300.00", "2026-11-10"),
        entry("REFUND", "50.00", "2026-11-11"),
        entry("WRITE_OFF", "100.00", "2026-11-12"),
      ],
      2026,
      11,
    );

    expect(totals).toHaveLength(1);
    expect(totals[0].currency).toBe("EUR");
    expect(totals[0].issued.toFixed(2)).toBe("800.00");
    expect(totals[0].recognized.toFixed(2)).toBe("800.00");
    expect(totals[0].paid.toFixed(2)).toBe("250.00");
    expect(totals[0].writtenOff.toFixed(2)).toBe("100.00");
  });

  it("never mixes currencies and sorts the rows", () => {
    const totals = summariseRevenueMonth(
      [
        entry("PAYMENT", "100.00", "2026-11-10", "USD"),
        entry("PAYMENT", "200.00", "2026-11-10", "EUR"),
      ],
      2026,
      11,
    );

    expect(totals.map((total) => total.currency)).toEqual(["EUR", "USD"]);
    expect(totals[0].paid.toFixed(2)).toBe("200.00");
    expect(totals[1].paid.toFixed(2)).toBe("100.00");
  });
});

describe("revenueMonthEntries", () => {
  it("flattens an invoice into every dated movement", () => {
    const entries = revenueMonthEntries([
      invoice({
        payments: [payment("300.00")],
        refunds: [refund("50.00")],
        writeOffs: [writeOff("100.00")],
      }),
    ]);

    expect(entries.map((entry) => entry.kind)).toEqual([
      "ISSUED",
      "RECOGNIZED",
      "PAYMENT",
      "REFUND",
      "WRITE_OFF",
    ]);
  });

  it("flattens a credit note as a single reducing movement", () => {
    const entries = revenueMonthEntries([
      invoice({
        kind: "CREDIT_NOTE",
        creditNoteFor: { id: "invoice-1", issuedOn: day("2026-11-01") },
        recognizedOn: null,
        recognizedAmount: null,
      }),
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("CREDIT_NOTE");
  });
});

describe("revenueDocumentInputSchema", () => {
  const base = {
    kind: "INVOICE",
    projectId: "project-1",
    creditNoteForId: "",
    amount: "1 000,00",
    issuedOn: "2026-11-01",
    dueOn: "2026-11-30",
    recognizedOn: "",
    recognizedAmount: "",
    notes: "",
  };

  it("accepts an invoice and parses its amount and dates", () => {
    const parsed = revenueDocumentInputSchema.safeParse(base);

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.amount.toFixed(2)).toBe("1000.00");
    expect(parsed.success && parsed.data.dueOn?.toISOString().slice(0, 10)).toBe(
      "2026-11-30",
    );
  });

  it("requires a project and a due date on an invoice", () => {
    const noProject = revenueDocumentInputSchema.safeParse({ ...base, projectId: "" });
    expect(noProject.success).toBe(false);

    const noDueDate = revenueDocumentInputSchema.safeParse({ ...base, dueOn: "" });
    expect(noDueDate.success).toBe(false);
  });

  it("requires the reduced invoice on a credit note", () => {
    const parsed = revenueDocumentInputSchema.safeParse({
      ...base,
      kind: "CREDIT_NOTE",
      projectId: "",
      dueOn: "",
    });

    expect(parsed.success).toBe(false);
    expect(parsed.success ? [] : parsed.error.issues).toContainEqual(
      expect.objectContaining({ path: ["creditNoteForId"] }),
    );
  });

  it("refuses a due date or a recognition on a credit note", () => {
    const target = { ...base, kind: "CREDIT_NOTE", projectId: "", creditNoteForId: "invoice-1" };

    expect(revenueDocumentInputSchema.safeParse({ ...target, dueOn: "2026-11-30" }).success).toBe(
      false,
    );
    expect(
      revenueDocumentInputSchema.safeParse({
        ...target,
        dueOn: "",
        recognizedOn: "2026-11-01",
        recognizedAmount: "100.00",
      }).success,
    ).toBe(false);
  });

  it("requires the recognition date and amount together", () => {
    const onlyDate = revenueDocumentInputSchema.safeParse({
      ...base,
      recognizedOn: "2026-11-01",
    });
    expect(onlyDate.success).toBe(false);

    const onlyAmount = revenueDocumentInputSchema.safeParse({
      ...base,
      recognizedAmount: "1000.00",
    });
    expect(onlyAmount.success).toBe(false);

    const both = revenueDocumentInputSchema.safeParse({
      ...base,
      recognizedOn: "2026-11-01",
      recognizedAmount: "1000.00",
    });
    expect(both.success).toBe(true);
  });

  it("refuses a non-positive amount", () => {
    expect(revenueDocumentInputSchema.safeParse({ ...base, amount: "0" }).success).toBe(false);
    expect(revenueDocumentInputSchema.safeParse({ ...base, amount: "-10" }).success).toBe(false);
  });
});
