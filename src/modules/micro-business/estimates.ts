import Decimal from "decimal.js";
import { z } from "zod";
import { parseAmountInput, type Currency } from "@/lib/money";
import { optionalText } from "@/lib/validation";

/**
 * Estimate and scope-change versions (M10-04).
 *
 * A project has one baseline and then revisions or change requests. Every version is
 * an immutable set of item lines (`label`, signed amount): there is no edit path, so
 * an approved figure cannot silently change. A correction is a new version, and
 * approving it marks the previous approved version `SUPERSEDED` in the same database
 * transaction.
 *
 * A comparison is a pure function of two stored versions. Labels are unique inside a
 * version, so matching them is unambiguous; the output is deterministic and can be
 * reproduced months later without a saved snapshot.
 *
 * Lines are entered as `Libellé | montant`, one per line. A negative amount states a
 * reduction explicitly. The currency is the project's, never converted.
 */

export const ESTIMATE_VERSION_KINDS = ["BASELINE", "REVISION", "CHANGE_REQUEST"] as const;
export type EstimateVersionKind = (typeof ESTIMATE_VERSION_KINDS)[number];

export const ESTIMATE_VERSION_KIND_LABELS: Record<EstimateVersionKind, string> = {
  BASELINE: "Devis initial",
  REVISION: "Révision",
  CHANGE_REQUEST: "Demande de changement",
};

export const ESTIMATE_VERSION_STATUSES = ["DRAFT", "APPROVED", "SUPERSEDED"] as const;
export type EstimateVersionStatus = (typeof ESTIMATE_VERSION_STATUSES)[number];

export const ESTIMATE_VERSION_STATUS_LABELS: Record<EstimateVersionStatus, string> = {
  DRAFT: "Brouillon",
  APPROVED: "Approuvée",
  SUPERSEDED: "Remplacée",
};

/** One stored line of a version. */
export type EstimateItemRecord = {
  label: string;
  /** Signed exact amount. */
  amount: Decimal;
  /** Source order, preserved for display. */
  position: number;
};

/** One parsed line, before it is written. */
export type EstimateItemInput = {
  label: string;
  amount: Decimal;
};

export type EstimateVersionRecord = {
  id: string;
  projectId: string;
  projectName: string;
  versionNumber: number;
  kind: EstimateVersionKind;
  status: EstimateVersionStatus;
  currency: Currency;
  assumptions: string | null;
  notes: string | null;
  approvedAt: Date | null;
  items: EstimateItemRecord[];
};

/** The version's total, the exact sum of its signed lines. */
export function estimateTotal(items: readonly { amount: Decimal }[]): Decimal {
  return items.reduce((total, item) => total.plus(item.amount), new Decimal(0));
}

/** The next version number for a project: 1 for the baseline, then max + 1. */
export function nextVersionNumber(
  versions: readonly { versionNumber: number }[],
): number {
  return versions.reduce(
    (highest, version) => Math.max(highest, version.versionNumber),
    0,
  ) + 1;
}

/**
 * Why a version kind is refused for a project, or `null` when it is allowed.
 *
 * The first version must be the baseline; every later version must be a revision or a
 * change request. This keeps "what changed since the baseline" meaningful.
 */
export function versionKindRefusedReason(
  existingCount: number,
  kind: EstimateVersionKind,
): string | null {
  if (existingCount === 0) {
    return kind === "BASELINE"
      ? null
      : "La première version d'un projet doit être le devis initial.";
  }

  return kind === "BASELINE"
    ? "Le devis initial existe déjà : cette version doit être une révision ou une demande de changement."
    : null;
}

/** Why a version cannot be approved, or `null` when it can. */
export function approveRefusedReason(status: EstimateVersionStatus): string | null {
  if (status === "DRAFT") {
    return null;
  }

  return status === "APPROVED"
    ? "Cette version est déjà approuvée."
    : "Cette version a été remplacée par une version approuvée plus récente : seule une version en brouillon peut être approuvée.";
}

export type EstimateComparisonLine = {
  label: string;
  before: Decimal | null;
  after: Decimal | null;
  /** after − before; the missing side counts as zero. */
  delta: Decimal;
};

export type EstimateComparison = {
  beforeTotal: Decimal;
  afterTotal: Decimal;
  /** afterTotal − beforeTotal. */
  delta: Decimal;
  added: EstimateComparisonLine[];
  removed: EstimateComparisonLine[];
  changed: EstimateComparisonLine[];
};

function byLabel(
  left: EstimateComparisonLine,
  right: EstimateComparisonLine,
): number {
  return left.label.localeCompare(right.label);
}

/**
 * What changed between two versions, matched by label.
 *
 * Pure and deterministic: the same two stored versions always produce the same lines in
 * the same order. `added` is present only in the later version, `removed` only in the
 * earlier one, and `changed` carries a different amount on both sides. Unchanged lines
 * are omitted.
 */
export function compareEstimateVersions(
  before: readonly EstimateItemRecord[],
  after: readonly EstimateItemRecord[],
): EstimateComparison {
  const beforeByLabel = new Map(before.map((item) => [item.label, item.amount]));
  const afterByLabel = new Map(after.map((item) => [item.label, item.amount]));
  const labels = [...new Set([...beforeByLabel.keys(), ...afterByLabel.keys()])].sort();

  const added: EstimateComparisonLine[] = [];
  const removed: EstimateComparisonLine[] = [];
  const changed: EstimateComparisonLine[] = [];

  for (const label of labels) {
    const beforeAmount = beforeByLabel.get(label) ?? null;
    const afterAmount = afterByLabel.get(label) ?? null;

    if (beforeAmount === null && afterAmount !== null) {
      added.push({ label, before: null, after: afterAmount, delta: afterAmount });
      continue;
    }

    if (beforeAmount !== null && afterAmount === null) {
      removed.push({
        label,
        before: beforeAmount,
        after: null,
        delta: beforeAmount.negated(),
      });
      continue;
    }

    if (beforeAmount !== null && afterAmount !== null && !beforeAmount.equals(afterAmount)) {
      changed.push({
        label,
        before: beforeAmount,
        after: afterAmount,
        delta: afterAmount.minus(beforeAmount),
      });
    }
  }

  added.sort(byLabel);
  removed.sort(byLabel);
  changed.sort(byLabel);

  const beforeTotal = estimateTotal(before);
  const afterTotal = estimateTotal(after);

  return {
    beforeTotal,
    afterTotal,
    delta: afterTotal.minus(beforeTotal),
    added,
    removed,
    changed,
  };
}

export type ParsedEstimateItems =
  | { ok: true; items: EstimateItemInput[] }
  | { ok: false; message: string };

/**
 * Parses the `Libellé | montant` text area.
 *
 * Empty lines are ignored. The first `|` separates the label from the amount, so a
 * label cannot contain one. Duplicate labels (case-insensitive) are refused because the
 * comparison matches by label; a duplicate would make the result ambiguous.
 */
export function parseEstimateItems(text: string): ParsedEstimateItems {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");

  if (lines.length === 0) {
    return {
      ok: false,
      message: "Ajoutez au moins une ligne au format « Libellé | montant ».",
    };
  }

  const items: EstimateItemInput[] = [];
  const seen = new Set<string>();

  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    const separator = line.indexOf("|");

    if (separator === -1) {
      return {
        ok: false,
        message: `Ligne ${lineNumber} : utilisez le format « Libellé | montant ».`,
      };
    }

    const label = line.slice(0, separator).trim();
    const amountText = line.slice(separator + 1).trim();

    if (label === "") {
      return { ok: false, message: `Ligne ${lineNumber} : le libellé est requis.` };
    }

    const key = label.toLocaleLowerCase("fr-FR");
    if (seen.has(key)) {
      return {
        ok: false,
        message: `Le libellé « ${label} » apparaît deux fois : chaque ligne doit être unique pour rendre la comparaison fiable.`,
      };
    }
    seen.add(key);

    let value: Decimal;
    try {
      value = parseAmountInput(amountText);
    } catch {
      return {
        ok: false,
        message: `Ligne ${lineNumber} : montant invalide. Exemples acceptés : 12 000,00 ou -1 500,00.`,
      };
    }

    items.push({ label, amount: value });
  }

  return { ok: true, items };
}

export const estimateVersionInputSchema = z.object({
  projectId: z.string().trim().min(1, "Un projet est requis."),
  kind: z.enum(ESTIMATE_VERSION_KINDS, "Type de version inconnu."),
  assumptions: optionalText(4000, "Les hypothèses sont limitées à 4000 caractères."),
  notes: optionalText(2000, "Les notes sont limitées à 2000 caractères."),
  items: z
    .string()
    .trim()
    .min(1, "Ajoutez au moins une ligne au format « Libellé | montant »."),
});

export type EstimateVersionInput = z.input<typeof estimateVersionInputSchema>;
export type ValidatedEstimateVersionInput = z.output<typeof estimateVersionInputSchema>;
