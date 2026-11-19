import { z } from "zod";
import { FinalizedCostEntryError, CostEntryNotFoundError } from "./ledger";
import { InvalidAllocationMathError } from "./allocation";
import { InvalidAllocationPolicyError } from "./policy";

/**
 * Unallocated-cost inbox (M9-06): pure rules shared by the page and its actions.
 *
 * The inbox lists draft cost entries. An entry is *unallocated* when no allocation
 * carries any of it, *partial* when some remains, *allocated* when every cent is
 * carried — then it only waits for finalization, which is always a deliberate
 * action, never automatic. Totals follow the M9-02 conservation rule
 * (`allocated + unallocated = total`) and are never added across currencies.
 */

/** At most this many entries per bulk action; the page offers no more. */
export const INBOX_BULK_LIMIT = 50;

export const INBOX_ENTRY_STATES = ["UNALLOCATED", "PARTIAL", "ALLOCATED"] as const;
export type InboxEntryState = (typeof INBOX_ENTRY_STATES)[number];

export const INBOX_ENTRY_STATE_LABELS: Record<InboxEntryState, string> = {
  UNALLOCATED: "Non réparti",
  PARTIAL: "Partiellement réparti",
  ALLOCATED: "Réparti, à valider",
};

export function inboxEntryState(totals: {
  allocated: { amount: { isZero(): boolean } };
  unallocated: { amount: { isZero(): boolean } };
}): InboxEntryState {
  if (totals.unallocated.amount.isZero()) return "ALLOCATED";
  return totals.allocated.amount.isZero() ? "UNALLOCATED" : "PARTIAL";
}

/** The label imported entries carry on the first line of their notes. */
export function inboxEntryLabel(notes: string | null): string {
  const first = notes?.split("\n")[0]?.trim();
  return first ? first : "Sans libellé";
}

export type InboxView =
  | { kind: "error" }
  | { kind: "no-costs" }
  | { kind: "nothing-to-review" }
  | { kind: "list" };

/**
 * What the page shows. A read failure is never presented as an empty inbox, and an
 * inbox with nothing left to review is not the same as a ledger with no cost at all.
 */
export function inboxView(
  load: { ok: false } | { ok: true; entryCount: number; costCount: number },
): InboxView {
  if (!load.ok) return { kind: "error" };
  if (load.entryCount > 0) return { kind: "list" };
  return load.costCount === 0 ? { kind: "no-costs" } : { kind: "nothing-to-review" };
}

/** A French reason for one entry the bulk action could not process. */
export function allocationFailureReason(error: unknown): string {
  if (error instanceof FinalizedCostEntryError) return "Coût déjà validé : sa répartition est figée.";
  if (error instanceof CostEntryNotFoundError) return "Coût introuvable dans cet espace.";
  if (error instanceof InvalidAllocationMathError) {
    return "La répartition dépasserait le montant du coût ou n'aurait pas son signe.";
  }
  if (error instanceof InvalidAllocationPolicyError) {
    const message = error.message;
    if (message.includes("nothing left to allocate")) return "Rien à répartir : le coût est déjà entièrement réparti.";
    if (message.includes("no target has any weight")) {
      return "Aucune cible n'a de poids (par exemple aucun chiffre d'affaires sur la période) : rien n'a été réparti.";
    }
    if (message.includes("cannot weight")) return "Chiffre d'affaires dans une autre devise que le coût : convertissez d'abord.";
    if (message.includes("must not be negative")) return "Chiffre d'affaires net négatif sur la période pour une cible.";
    if (message.includes("archived")) return "Cette politique est archivée.";
    if (message.includes("one measure per target") || message.includes("revenue is read")) {
      return "Valeurs par cible manquantes ou en trop pour ce type de politique.";
    }
    return "Valeurs invalides pour cette politique.";
  }
  return "Répartition impossible pour ce coût.";
}

const entryIds = z
  .array(z.string().trim().min(1).max(64))
  .min(1, "Sélectionnez au moins un coût.")
  .max(INBOX_BULK_LIMIT, `Au plus ${INBOX_BULK_LIMIT} coûts par action.`)
  .refine((ids) => new Set(ids).size === ids.length, "Un coût est sélectionné deux fois.");

export const applyPolicySubmissionSchema = z
  .object({
    entryIds,
    policyId: z.string().trim().min(1, "Choisissez une politique.").max(64),
    /** Per-target values for seat, usage and manual policies: one entry at a time. */
    measures: z.array(z.string().trim().max(40)).max(100).nullable(),
    dryRun: z.boolean(),
  })
  .refine((value) => value.measures === null || value.entryIds.length === 1, {
    message: "Les valeurs par cible ne s'appliquent qu'à un seul coût à la fois.",
  });

export const finalizeSubmissionSchema = z.object({ entryIds });

export type ApplyPolicySubmission = z.input<typeof applyPolicySubmissionSchema>;

export type InboxPlannedRow = { dimensions: string; amount: string; measure: string };

export type InboxEntryOutcome = {
  entryId: string;
  ok: boolean;
  /** Set when `ok` is false. */
  reason: string | null;
  /** Preview and apply: what the policy produced for this entry. */
  planned: InboxPlannedRow[];
};

export type InboxActionResult =
  | { status: "ok"; message: string; outcomes: InboxEntryOutcome[] }
  | { status: "invalid" | "error"; message: string };

/** Short French description of a dimension set, for previews. */
export function describeDimensions(
  dimensions: Readonly<Record<string, unknown>>,
  projectNames: ReadonlyMap<string, string> = new Map(),
): string {
  const labels: Record<string, string> = {
    projectId: "Projet",
    clientId: "Client",
    repository: "Dépôt",
    developerId: "Développeur",
    agentId: "Agent",
    issueId: "Ticket",
    pullRequestId: "PR",
    environment: "Environnement",
  };
  const parts = Object.entries(labels)
    .filter(([key]) => typeof dimensions[key] === "string" && dimensions[key] !== "")
    .map(([key, label]) => {
      const value = dimensions[key] as string;
      return `${label} ${key === "projectId" ? (projectNames.get(value) ?? value) : value}`;
    });
  const tags = Array.isArray(dimensions.tags) ? (dimensions.tags as string[]) : [];
  if (tags.length > 0) parts.push(`Étiquettes ${tags.join(", ")}`);
  return parts.join(" · ") || "—";
}
