import type { ReconciliationStatus } from "./reconciliation";

/**
 * GitHub Copilot display rules (M11-08).
 *
 * Wording: these figures count **activity** — users who used Copilot, interactions,
 * suggestions — and every label says so. None of them measures productivity, value
 * produced or individual performance, and nothing is shown per member, so no ranking
 * can be built from this page.
 */

export type CopilotSeatStatus = ReconciliationStatus;

/**
 * GitHub's seat breakdown against the seats counted in its own seat list. Both are
 * provider figures, so they must agree exactly; an unread list cannot be compared.
 */
export function copilotSeatStatus(seats: { total: number; listedSeats: number | null }): CopilotSeatStatus {
  if (seats.listedSeats === null) return "INCOMPLETE";
  return seats.listedSeats === seats.total ? "RECONCILED" : "MISMATCH";
}

export const COPILOT_SEAT_STATUS_LABELS: Record<CopilotSeatStatus, string> = {
  RECONCILED: "Sièges concordants",
  MISMATCH: "Sièges discordants",
  INCOMPLETE: "Liste des sièges non lue en entier",
};

/** Activity labels, written so none of them reads as a productivity measure. */
export const COPILOT_ACTIVITY_LABELS = {
  dailyActiveUsers: "Utilisateurs actifs (jour)",
  weeklyActiveUsers: "Utilisateurs actifs (7 jours)",
  monthlyActiveUsers: "Utilisateurs actifs (28 jours)",
  monthlyActiveAgentUsers: "Utilisateurs du mode agent (28 jours)",
  dailyActiveCloudAgentUsers: "Utilisateurs de l'agent cloud (jour)",
  interactionCount: "Interactions lancées par les utilisateurs",
  codeGenerationCount: "Suggestions de code générées",
  codeAcceptanceCount: "Suggestions de code acceptées",
} as const;

export const COPILOT_ACTIVITY_NOTICE =
  "Ces chiffres décrivent une activité : ils ne mesurent ni la productivité, ni la valeur produite, ni la performance d'une personne.";
