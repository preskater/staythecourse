import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { createExchangeRateSnapshot } from "./exchange";
import {
  invoiceInputSchema,
  reconcileInvoice,
  summarizePeriod,
  type Invoice,
  type InvoiceLineCategory,
} from "./invoice";
import { createCostSource } from "./source";

const usdToEur = createExchangeRateSnapshot({
  id: "rate-1",
  baseCurrency: "USD",
  quoteCurrency: "EUR",
  rate: "0.9",
  rateDate: "2026-10-31",
  source: createCostSource({ kind: "manual", enteredBy: "user-1", capturedAt: "2026-11-01T00:00:00Z" }),
  recordedAt: "2026-11-01T00:00:00Z",
});

function invoice(total: string, lines: [InvoiceLineCategory, string][], overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: "invoice-1",
    provider: "OPENAI",
    number: "INV-001",
    periodStart: "2026-10-01",
    periodEnd: "2026-10-31",
    issuedOn: "2026-11-02",
    currency: "USD",
    total: new Decimal(total),
    rate: null,
    lines: lines.map(([category, amount], index) => ({
      id: `line-${index}`,
      label: category,
      amount: new Decimal(amount),
      category,
    })),
    ...overrides,
  };
}

const usd = (amount: string) => new Map([["USD", new Decimal(amount)]]);

describe("reconcileInvoice", () => {
  it("reconciles usage to the cent, rounding the raw provider sum once", () => {
    const result = reconcileInvoice(invoice("100.00", [["USAGE", "100.00"]]), usd("99.9950000001"));
    expect(result).toMatchObject({ status: "RECONCILED", provider: "100.00", usageVariance: "0.00", linesGap: "0.00" });
    expect(result.lines).toEqual([{ id: "line-0", status: "MATCHED" }]);
  });

  it("accepts a usage gap of exactly the tolerance and flags one above it", () => {
    expect(reconcileInvoice(invoice("100.01", [["USAGE", "100.01"]]), usd("100")).status).toBe("RECONCILED");
    const above = reconcileInvoice(invoice("100.02", [["USAGE", "100.02"]]), usd("100"));
    expect(above).toMatchObject({ status: "VARIANCE", usageVariance: "0.02" });
    expect(above.lines[0].status).toBe("VARIANCE");
  });

  it.each([
    ["CREDIT", "-20.00", "80.00"],
    ["DISCOUNT", "-5.00", "95.00"],
    ["TAX", "20.00", "120.00"],
  ] as const)("explains a %s line without touching the usage match", (category, amount, total) => {
    const result = reconcileInvoice(invoice(total, [["USAGE", "100.00"], [category, amount]]), usd("100"));
    expect(result.status).toBe("RECONCILED");
    expect(result.byCategory[category]).toBe(amount);
    expect(result.lines.map((line) => line.status)).toEqual(["MATCHED", "EXPLAINED"]);
  });

  it("converts USD usage with the invoice's snapshot and classifies the FX residue", () => {
    // 111.11 USD × 0.9 = 99.999 → 100.00 EUR; the invoice bills 100.00 usage + 0.40 FX.
    const result = reconcileInvoice(
      invoice("100.40", [["USAGE", "100.00"], ["FX", "0.40"]], { currency: "EUR", rate: usdToEur }),
      usd("111.11"),
    );
    expect(result).toMatchObject({ status: "RECONCILED", provider: "100.00" });
    expect(result.byCategory.FX).toBe("0.40");
  });

  it("leaves the provider figure unknown, not zero, when no rate converts its currency", () => {
    const result = reconcileInvoice(invoice("100.00", [["USAGE", "100.00"]], { currency: "EUR" }), usd("111.11"));
    expect(result).toMatchObject({ status: "MISSING_RATE", provider: null, usageVariance: null, unconvertible: ["USD"] });
    expect(result.lines[0].status).toBe("UNMATCHED");
  });

  it("reports missing usage when the provider reported nothing for the period", () => {
    const result = reconcileInvoice(invoice("50.00", [["USAGE", "50.00"], ["TAX", "0.00"]]), new Map());
    expect(result).toMatchObject({ status: "MISSING_USAGE", provider: null });
    expect(result.lines.map((line) => line.status)).toEqual(["UNMATCHED", "EXPLAINED"]);
  });

  it("keeps an OTHER line unmatched and visible, even when the totals agree", () => {
    const result = reconcileInvoice(invoice("100.00", [["USAGE", "100.00"], ["OTHER", "0.00"]]), usd("100"));
    expect(result.status).toBe("VARIANCE");
    expect(result.lines[1].status).toBe("UNMATCHED");
  });

  it("flags a total that the typed lines do not add up to", () => {
    const result = reconcileInvoice(invoice("101.00", [["USAGE", "100.00"]]), usd("100"));
    expect(result).toMatchObject({ status: "VARIANCE", linesGap: "1.00", linesTotal: "100.00" });
  });

  it("does not let usage lines disappear: no usage line against reported usage is a variance", () => {
    const result = reconcileInvoice(invoice("-10.00", [["CREDIT", "-10.00"]]), usd("40"));
    expect(result).toMatchObject({ status: "VARIANCE", usageVariance: "-40.00" });
  });
});

describe("summarizePeriod", () => {
  const totals = (entries: Record<string, Record<string, string>>) =>
    new Map(
      Object.entries(entries).map(([provider, byCurrency]) => [
        provider,
        new Map(Object.entries(byCurrency).map(([currency, amount]) => [currency, new Decimal(amount)])),
      ]),
    );

  it("flags a missing invoice, a missing usage, and keeps the estimate apart", () => {
    const rows = summarizePeriod({
      estimated: totals({ OPENAI: { USD: "90" }, ANTHROPIC: { EUR: "10" } }),
      reported: totals({ OPENAI: { USD: "100.004" } }),
      invoiceCounts: new Map([["ANTHROPIC", 1]]),
    });

    expect(rows).toEqual([
      {
        provider: "ANTHROPIC",
        state: "MISSING_USAGE",
        estimated: [{ currency: "EUR", amount: "10.00" }],
        reported: [],
        estimateVariance: [],
        invoiceCount: 1,
      },
      {
        provider: "OPENAI",
        state: "MISSING_INVOICE",
        estimated: [{ currency: "USD", amount: "90.00" }],
        reported: [{ currency: "USD", amount: "100.00" }],
        estimateVariance: [{ currency: "USD", amount: "-10.00" }],
        invoiceCount: 0,
      },
    ]);
  });

  it("returns no row for an empty month rather than zeros", () => {
    expect(summarizePeriod({ estimated: new Map(), reported: new Map(), invoiceCounts: new Map() })).toEqual([]);
  });
});

describe("invoiceInputSchema", () => {
  const valid = {
    provider: "OPENAI",
    number: "INV-001",
    periodStart: "2026-10-01",
    periodEnd: "2026-10-31",
    issuedOn: "2026-11-02",
    currency: "USD",
    total: "100,00",
    exchangeRateSnapshotId: "",
    notes: "",
    lines: [{ label: "Usage API", amount: "100,00", category: "USAGE" }],
  };

  it("accepts a typed invoice with exact amounts", () => {
    const parsed = invoiceInputSchema.parse(valid);
    expect(parsed.total.toFixed(2)).toBe("100.00");
    expect(parsed.exchangeRateSnapshotId).toBeNull();
  });

  it("refuses an FX line without a rate snapshot and an inverted period", () => {
    const result = invoiceInputSchema.safeParse({
      ...valid,
      periodEnd: "2026-09-30",
      lines: [{ label: "Change", amount: "1,00", category: "FX" }],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join("."))).toEqual(["periodEnd", "lines.0.category"]);
  });
});
