import Decimal from "decimal.js";
import { z } from "zod";
import { isSupportedCurrency } from "@/lib/money";
import { parseImportDate } from "@/modules/budget/import";

/**
 * CSV import of cost entries (M9-05). Pure helpers, safe for the browser.
 *
 * Same flow as the budget import: the browser parses the file, the owner checks the
 * preview, and only normalised rows reach the Server Action, which validates them again
 * and decides duplicates against the database. The CSV tokenizer and the date reader
 * are the budget import's (`parseCsv`, `parseImportDate`).
 *
 * Rules, documented once here:
 * - **Date**: `YYYY-MM-DD`, an ISO instant (`2026-03-01T…`, the written day is kept),
 *   or day-first French forms. An optional end-of-period column sets `periodEnd`;
 *   without it the period is the single day.
 * - **Amount**: signed. Positive is a cost, negative a credit or a refund. Comma or dot
 *   decimals; when both appear, the last one is the decimal separator (`1 234,56`,
 *   `1,234.56`). Accounting parentheses mean negative. Up to 10 decimals are read
 *   exactly, then rounded half-up to the cent once — the ledger's boundary rule — and
 *   the preview says so. Zero is refused.
 * - **Currency**: the row's currency column, else the mapping's default. Never guessed
 *   and never converted.
 * - **Duplicates**: a row is identified by its source plus its reference when the file
 *   has one, else by a fingerprint of period, currency, amount and label (whitespace
 *   collapsed). The server hashes that identity into `CostEntry.importKey`, unique per
 *   workspace, so importing the same file twice creates nothing. Two identical rows
 *   without reference in one file are therefore one cost: the second is reported as a
 *   duplicate, never silently dropped.
 */

export const COST_IMPORT_ROW_LIMIT = 2000;
export const COST_IMPORT_LABEL_MAX = 200;
export const COST_IMPORT_NOTES_MAX = 1700;
export const COST_IMPORT_REF_MAX = 200;
export const COST_IMPORT_SOURCE_MAX = 80;
const HEADER_MAX = 120;
const AMOUNT_MAX_DECIMALS = 10;

export const COST_IMPORT_FIELDS = [
  "date",
  "periodEnd",
  "label",
  "amount",
  "currency",
  "reference",
  "notes",
] as const;
export type CostImportField = (typeof COST_IMPORT_FIELDS)[number];

export const COST_IMPORT_FIELD_LABELS: Record<CostImportField | "ignore", string> = {
  ignore: "Ignorer",
  date: "Date (début de période)",
  periodEnd: "Fin de période",
  label: "Libellé",
  amount: "Montant",
  currency: "Devise",
  reference: "Référence (n° de facture, ID de ligne)",
  notes: "Notes",
};

/** Field → column index in the current file. */
export type CostImportMapping = Record<CostImportField, number | null>;
/** Field → header name, the reusable form saved per source. */
export type SavedCostImportColumns = Partial<Record<CostImportField, string>>;

export function emptyCostMapping(): CostImportMapping {
  return {
    date: null,
    periodEnd: null,
    label: null,
    amount: null,
    currency: null,
    reference: null,
    notes: null,
  };
}

function normalizeHeader(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

/** Best-effort guess from French and English provider headers; always editable. */
export function guessCostMapping(header: readonly string[]): CostImportMapping {
  const mapping = emptyCostMapping();
  const taken = new Set<number>();
  const assign = (field: CostImportField, test: RegExp) => {
    const index = header.findIndex(
      (name, position) => !taken.has(position) && test.test(normalizeHeader(name)),
    );
    if (mapping[field] === null && index >= 0) {
      mapping[field] = index;
      taken.add(index);
    }
  };

  assign("periodEnd", /\bfin\b|\bend\b|\bto\b|\bau\b/);
  assign("date", /date|debut|start|from|period|jour|day/);
  assign("label", /libell|intitul|description|label|produit|product|service|item/);
  assign("amount", /montant|amount|cost|cout|total|price|prix/);
  assign("currency", /devise|currency|monnaie/);
  assign("reference", /reference|\bref\b|invoice|facture|\bid\b|numero|number/);
  assign("notes", /note|comment|memo/);

  return mapping;
}

/** The saved columns resolved against a new file's header, by normalised name. */
export function mappingFromSaved(
  header: readonly string[],
  columns: SavedCostImportColumns,
): CostImportMapping {
  const mapping = emptyCostMapping();
  const names = header.map(normalizeHeader);

  for (const field of COST_IMPORT_FIELDS) {
    const wanted = columns[field];
    if (wanted !== undefined) {
      const index = names.indexOf(normalizeHeader(wanted));
      mapping[field] = index >= 0 ? index : null;
    }
  }

  return mapping;
}

export function toSavedColumns(
  header: readonly string[],
  mapping: CostImportMapping,
): SavedCostImportColumns {
  const columns: SavedCostImportColumns = {};

  for (const field of COST_IMPORT_FIELDS) {
    const index = mapping[field];
    if (index !== null && header[index] !== undefined && header[index].trim() !== "") {
      columns[field] = header[index].trim();
    }
  }

  return columns;
}

/** Why the mapping cannot be used yet; empty means complete. */
export function missingCostMappingReasons(
  mapping: CostImportMapping,
  defaultCurrency: string | null,
): string[] {
  const reasons: string[] = [];

  if (mapping.date === null) reasons.push("Associez une colonne « Date ».");
  if (mapping.label === null) reasons.push("Associez une colonne « Libellé ».");
  if (mapping.amount === null) reasons.push("Associez une colonne « Montant ».");
  if (mapping.currency === null && !defaultCurrency) {
    reasons.push("Associez une colonne « Devise » ou choisissez une devise par défaut.");
  }

  return reasons;
}

export class InvalidCostAmountError extends Error {
  constructor(readonly raw: string) {
    super(`Unreadable cost amount: ${raw}`);
    this.name = "InvalidCostAmountError";
  }
}

/** A signed amount as provider exports and invoices write it, read exactly. */
export function parseCostAmount(raw: string): Decimal {
  let text = raw.trim();
  let negative = false;
  const parenthesised = /^\((.*)\)$/.exec(text);

  if (parenthesised) {
    text = parenthesised[1];
    negative = true;
  }

  text = text.replace(/[\s  €$£]/g, "");
  const lastComma = text.lastIndexOf(",");
  const lastDot = text.lastIndexOf(".");

  if (lastComma >= 0 && lastDot >= 0) {
    text =
      lastComma > lastDot
        ? text.replace(/\./g, "").replace(",", ".")
        : text.replace(/,/g, "");
  } else if (lastComma >= 0) {
    if (text.indexOf(",") !== lastComma) throw new InvalidCostAmountError(raw);
    text = text.replace(",", ".");
  }

  if (!new RegExp(`^[+-]?\\d+(\\.\\d{1,${AMOUNT_MAX_DECIMALS}})?$`).test(text)) {
    throw new InvalidCostAmountError(raw);
  }

  const value = new Decimal(text.startsWith("+") ? text.slice(1) : text);
  return negative ? value.negated() : value;
}

/** A calendar day (`YYYY-MM-DD`) from a cell; ISO instants keep their written day. */
export function parseCostDate(raw: string): string {
  const trimmed = raw.trim();
  const instant = /^(\d{4}-\d{2}-\d{2})[T ]/.exec(trimmed);
  return parseImportDate(instant ? instant[1] : trimmed).toISOString().slice(0, 10);
}

export type CostImportRow = {
  /** 1-based line in the file, header included. */
  line: number;
  date: string | null;
  periodEnd: string | null;
  label: string;
  /** Exact signed amount rounded to the cent (`-45.90`), or null when unreadable. */
  amount: string | null;
  /** True when the file held more than two decimals. */
  rounded: boolean;
  currency: string | null;
  reference: string | null;
  notes: string | null;
  /** French rejection reasons; a row with reasons is never submitted. */
  errors: string[];
};

export type CostImportBuild = {
  rows: CostImportRow[];
  truncated: boolean;
};

function cell(row: readonly string[], index: number | null): string {
  return index === null ? "" : (row[index] ?? "").trim();
}

export function buildCostImportRows(input: {
  table: readonly (readonly string[])[];
  mapping: CostImportMapping;
  hasHeader: boolean;
  defaultCurrency: string | null;
}): CostImportBuild {
  const rows: CostImportRow[] = [];
  let truncated = false;

  for (let index = input.hasHeader ? 1 : 0; index < input.table.length; index += 1) {
    const source = input.table[index];

    if (source.every((value) => value.trim() === "")) continue;

    if (rows.length >= COST_IMPORT_ROW_LIMIT) {
      truncated = true;
      break;
    }

    const errors: string[] = [];
    const read = (field: CostImportField) => cell(source, input.mapping[field]);

    let date: string | null = null;
    const rawDate = read("date");
    if (rawDate === "") {
      errors.push("Date manquante.");
    } else {
      try {
        date = parseCostDate(rawDate);
      } catch {
        errors.push(`Date illisible « ${rawDate} ».`);
      }
    }

    let periodEnd: string | null = null;
    const rawEnd = read("periodEnd");
    if (rawEnd !== "") {
      try {
        periodEnd = parseCostDate(rawEnd);
        if (date !== null && periodEnd < date) {
          errors.push("La fin de période précède la date de début.");
        }
      } catch {
        errors.push(`Fin de période illisible « ${rawEnd} ».`);
      }
    }

    const label = read("label");
    if (label === "") errors.push("Libellé manquant.");
    else if (label.length > COST_IMPORT_LABEL_MAX) {
      errors.push(`Libellé trop long (plus de ${COST_IMPORT_LABEL_MAX} caractères).`);
    }

    let amount: string | null = null;
    let rounded = false;
    const rawAmount = read("amount");
    if (rawAmount === "") {
      errors.push("Montant manquant.");
    } else {
      try {
        const exact = parseCostAmount(rawAmount);
        const cents = exact.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
        rounded = !cents.equals(exact);
        if (cents.isZero()) errors.push("Montant nul : rien à enregistrer.");
        else amount = cents.toFixed(2);
      } catch {
        errors.push(`Montant illisible « ${rawAmount} ».`);
      }
    }

    const currency = (read("currency") || input.defaultCurrency || "").toUpperCase();
    if (currency === "") errors.push("Devise manquante.");
    else if (!isSupportedCurrency(currency)) errors.push(`Devise non prise en charge « ${currency} ».`);

    const reference = read("reference");
    if (reference.length > COST_IMPORT_REF_MAX) errors.push("Référence trop longue.");

    const notes = read("notes");

    rows.push({
      line: index + 1,
      date,
      periodEnd,
      label,
      amount,
      rounded,
      currency: currency === "" ? null : currency,
      reference: reference === "" ? null : reference,
      notes: notes === "" ? null : notes.slice(0, COST_IMPORT_NOTES_MAX),
      errors,
    });
  }

  return { rows, truncated };
}

/**
 * The identity of a row before hashing: source, then reference or fingerprint.
 * NUL separators keep two different tuples from joining into the same text.
 */
export function costImportIdentity(
  source: string,
  row: { date: string; periodEnd: string | null; currency: string; amount: string; label: string; reference: string | null },
): string {
  const base = source.trim().toLowerCase();

  if (row.reference !== null) {
    return ["ref", base, row.reference.trim()].join("\u0000");
  }

  return [
    "fp",
    base,
    row.date,
    row.periodEnd ?? row.date,
    row.currency,
    new Decimal(row.amount).toFixed(2),
    row.label.replace(/\s+/g, " ").trim().toLowerCase(),
  ].join("\u0000");
}

/* Server contract. */

const dayString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date attendue au format AAAA-MM-JJ.")
  .refine((value) => {
    try {
      return parseImportDate(value) instanceof Date;
    } catch {
      return false;
    }
  }, "Date invalide.");

export const costImportRowSchema = z
  .object({
    line: z.number().int().min(1),
    date: dayString,
    periodEnd: dayString.nullable(),
    label: z.string().trim().min(1, "Libellé manquant.").max(COST_IMPORT_LABEL_MAX, "Libellé trop long."),
    amount: z
      .string()
      .regex(/^-?\d{1,16}\.\d{2}$/, "Montant attendu au centime près.")
      .refine((value) => !new Decimal(value).isZero(), "Montant nul : rien à enregistrer."),
    currency: z.string().refine(isSupportedCurrency, "Devise non prise en charge."),
    reference: z.string().trim().min(1).max(COST_IMPORT_REF_MAX, "Référence trop longue.").nullable(),
    notes: z.string().max(COST_IMPORT_NOTES_MAX, "Notes trop longues.").nullable(),
  })
  .refine((row) => row.periodEnd === null || row.periodEnd >= row.date, {
    message: "La fin de période précède la date de début.",
  });

export type CostImportRowSubmission = z.output<typeof costImportRowSchema>;

const headerName = z.string().trim().min(1).max(HEADER_MAX);

export const savedColumnsSchema = z
  .object(Object.fromEntries(COST_IMPORT_FIELDS.map((field) => [field, headerName.optional()])) as Record<CostImportField, z.ZodOptional<typeof headerName>>)
  .strict();

export const costImportSubmissionSchema = z.object({
  source: z.string().trim().min(1, "Nommez la source.").max(COST_IMPORT_SOURCE_MAX, "Nom de source trop long."),
  delimiter: z.enum([";", ",", "\t", "|"]),
  hasHeader: z.boolean(),
  columns: savedColumnsSchema,
  defaultCurrency: z.string().refine(isSupportedCurrency, "Devise non prise en charge.").nullable(),
  /** True for the preview: classify every row, write nothing. */
  dryRun: z.boolean(),
  /** Lines the browser already rejected, with their reasons; counted, never written. */
  rejectedInFile: z.number().int().min(0).max(COST_IMPORT_ROW_LIMIT),
  /** Rows stay raw here: the server validates each one and rejects it with a reason. */
  rows: z.array(z.unknown()).min(1, "Aucune ligne à importer.").max(COST_IMPORT_ROW_LIMIT, `Un import est limité à ${COST_IMPORT_ROW_LIMIT} lignes.`),
});

export type CostImportSubmission = z.input<typeof costImportSubmissionSchema>;

export type CostImportRowOutcome = {
  line: number;
  status: "new" | "created" | "duplicate" | "rejected";
  /** Always set for `duplicate` and `rejected`. */
  reason: string | null;
};

export type CostImportSummary = {
  importId: string | null;
  received: number;
  created: number;
  duplicates: number;
  rejected: number;
  rejectedInFile: number;
};

export type CostImportActionResult =
  | { status: "ok"; dryRun: boolean; summary: CostImportSummary; outcomes: CostImportRowOutcome[] }
  | { status: "invalid"; message: string }
  | { status: "error"; message: string };
