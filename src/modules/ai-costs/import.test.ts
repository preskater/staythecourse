import { describe, expect, it } from "vitest";
import { parseCsv } from "@/modules/budget/import";
import {
  buildCostImportRows,
  costImportIdentity,
  costImportRowSchema,
  COST_IMPORT_ROW_LIMIT,
  emptyCostMapping,
  guessCostMapping,
  mappingFromSaved,
  missingCostMappingReasons,
  parseCostAmount,
  parseCostDate,
  toSavedColumns,
} from "./import";

describe("parseCostAmount", () => {
  it.each([
    ["12,50", "12.5"],
    ["1 234,56", "1234.56"],
    ["1.234,56", "1234.56"],
    ["1,234.56", "1234.56"],
    ["-45.90", "-45.9"],
    ["(45,90)", "-45.9"],
    ["+3", "3"],
    ["0.0004", "0.0004"],
    ["12 €", "12"],
  ])("reads %s exactly", (raw, expected) => {
    expect(parseCostAmount(raw).toString()).toBe(expected);
  });

  it.each(["", "abc", "1,2,3", "1.23456789012", "--4"])("refuses %s", (raw) => {
    expect(() => parseCostAmount(raw)).toThrow();
  });
});

describe("parseCostDate", () => {
  it("reads ISO days, ISO instants and French forms", () => {
    expect(parseCostDate("2026-03-01")).toBe("2026-03-01");
    expect(parseCostDate("2026-03-01T23:59:00Z")).toBe("2026-03-01");
    expect(parseCostDate("15/03/2026")).toBe("2026-03-15");
    expect(() => parseCostDate("31/02/2026")).toThrow();
  });
});

const csv = [
  "Date;Fin;Description;Montant;Devise;Facture",
  "2026-03-01;2026-03-31;API usage;120,00;USD;INV-1",
  "2026-03-01;;Remboursement;-20,00;USD;INV-2",
  "2026-03-02;;Arrondi;0,005;EUR;",
  "bad;;Sans date;10;EUR;",
  "2026-03-03;;Sans montant;;EUR;",
  "2026-03-04;;Devise inconnue;10;JPY;",
  "2026-03-05;2026-03-01;Période inversée;10;EUR;",
  "2026-03-06;;Zéro;0,00;EUR;",
].join("\n");

function build(text = csv, defaultCurrency: string | null = null) {
  const table = parseCsv(text, ";");
  return buildCostImportRows({
    table,
    mapping: guessCostMapping(table[0]),
    hasHeader: true,
    defaultCurrency,
  });
}

describe("buildCostImportRows", () => {
  it("guesses the provider headers", () => {
    const table = parseCsv(csv, ";");
    expect(guessCostMapping(table[0])).toEqual({
      date: 0,
      periodEnd: 1,
      label: 2,
      amount: 3,
      currency: 4,
      reference: 5,
      notes: null,
    });
  });

  it("keeps costs, credits and periods, and rounds once to the cent", () => {
    const [cost, refund, rounded] = build().rows;
    expect(cost).toMatchObject({ line: 2, date: "2026-03-01", periodEnd: "2026-03-31", amount: "120.00", currency: "USD", reference: "INV-1", errors: [] });
    expect(refund).toMatchObject({ amount: "-20.00", periodEnd: null, errors: [] });
    expect(rounded).toMatchObject({ amount: "0.01", rounded: true, reference: null, errors: [] });
  });

  it("names the reason of every rejected line", () => {
    const rejected = build().rows.slice(3).map((row) => [row.line, row.errors]);
    expect(rejected).toEqual([
      [5, ["Date illisible « bad »."]],
      [6, ["Montant manquant."]],
      [7, ["Devise non prise en charge « JPY »."]],
      [8, ["La fin de période précède la date de début."]],
      [9, ["Montant nul : rien à enregistrer."]],
    ]);
  });

  it("uses the default currency when the file has none", () => {
    const text = "Date;Libellé;Montant\n2026-03-01;Abonnement;10";
    expect(build(text, "EUR").rows[0]).toMatchObject({ currency: "EUR", errors: [] });
    expect(build(text, null).rows[0].errors).toEqual(["Devise manquante."]);
  });

  it("bounds the file to the row limit and says so", () => {
    const lines = Array.from({ length: COST_IMPORT_ROW_LIMIT + 5 }, (_, index) => `2026-03-01;Ligne ${index};1;EUR`);
    const result = build(["Date;Libellé;Montant;Devise", ...lines].join("\n"));
    expect(result.rows).toHaveLength(COST_IMPORT_ROW_LIMIT);
    expect(result.truncated).toBe(true);
  });
});

describe("mapping reuse", () => {
  it("saves header names and finds them again in another column order", () => {
    const first = ["Date", "Description", "Montant", "Devise"];
    const saved = toSavedColumns(first, guessCostMapping(first));
    expect(saved).toEqual({ date: "Date", label: "Description", amount: "Montant", currency: "Devise" });

    const reordered = mappingFromSaved(["devise", "MONTANT", "Date", "Description", "Autre"], saved);
    expect(reordered).toMatchObject({ date: 2, label: 3, amount: 1, currency: 0, reference: null });
  });

  it("explains what is missing", () => {
    expect(missingCostMappingReasons(emptyCostMapping(), null)).toHaveLength(4);
    expect(missingCostMappingReasons({ ...emptyCostMapping(), date: 0, label: 1, amount: 2 }, "EUR")).toEqual([]);
  });
});

describe("costImportIdentity", () => {
  const row = { date: "2026-03-01", periodEnd: null, currency: "EUR", amount: "10.00", label: "Abonnement  Pro", reference: null };

  it("uses the reference when present, so a corrected label stays the same row", () => {
    const withRef = { ...row, reference: "INV-1" };
    expect(costImportIdentity("OpenAI", withRef)).toBe(costImportIdentity("openai ", { ...withRef, label: "Autre" }));
  });

  it("falls back to a fingerprint of period, currency, amount and label", () => {
    expect(costImportIdentity("OpenAI", row)).toBe(costImportIdentity("OpenAI", { ...row, label: "abonnement pro", periodEnd: "2026-03-01" }));
    expect(costImportIdentity("OpenAI", row)).not.toBe(costImportIdentity("OpenAI", { ...row, amount: "-10.00" }));
    expect(costImportIdentity("OpenAI", row)).not.toBe(costImportIdentity("Anthropic", row));
  });
});

describe("costImportRowSchema", () => {
  const valid = { line: 2, date: "2026-03-01", periodEnd: null, label: "x", amount: "-1.50", currency: "EUR", reference: null, notes: null };

  it("accepts a normalised row and refuses tampered ones", () => {
    expect(costImportRowSchema.safeParse(valid).success).toBe(true);
    expect(costImportRowSchema.safeParse({ ...valid, amount: "1.505" }).success).toBe(false);
    expect(costImportRowSchema.safeParse({ ...valid, amount: "0.00" }).success).toBe(false);
    expect(costImportRowSchema.safeParse({ ...valid, currency: "JPY" }).success).toBe(false);
    expect(costImportRowSchema.safeParse({ ...valid, date: "2026-02-31" }).success).toBe(false);
    expect(costImportRowSchema.safeParse({ ...valid, periodEnd: "2026-02-01" }).success).toBe(false);
  });
});
