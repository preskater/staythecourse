import { z } from "zod";
import { toDateOnlyString } from "@/lib/dates";
import type { Currency } from "@/lib/money";
import {
  currencyCode,
  optionalDate,
  optionalId,
  optionalText,
} from "@/lib/validation";

/**
 * Micro-business module: clients and projects.
 *
 * A project's `billingModel` is an explicit choice, never derived from its name or from
 * the presence of a client: an internal or non-billable project is expected to produce
 * no revenue, while a fixed-price, time-and-materials or retainer project will meet the
 * revenue model (M10-02) at its own boundary. `billingBehaviour` is the single place
 * that decision lives, so later milestones branch on it instead of on ad-hoc lists.
 *
 * Archiving is a reversible stamp, not a deletion: an archived client or project keeps
 * every field it had, and restoring only clears the stamp.
 */

export const BILLING_MODELS = [
  "FIXED_PRICE",
  "TIME_AND_MATERIALS",
  "RETAINER",
  "INTERNAL",
  "NON_BILLABLE",
] as const;
export type BillingModel = (typeof BILLING_MODELS)[number];

export const PROJECT_STATUSES = ["ACTIVE", "COMPLETED"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const BILLING_MODEL_LABELS: Record<BillingModel, string> = {
  FIXED_PRICE: "Forfait",
  TIME_AND_MATERIALS: "Régie (temps et matériel)",
  RETAINER: "Abonnement",
  INTERNAL: "Interne",
  NON_BILLABLE: "Non facturable",
};

export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  ACTIVE: "En cours",
  COMPLETED: "Terminé",
};

export type BillingBehaviour = {
  /** The project is expected to produce revenue. */
  billable: boolean;
  /** Validation requires a client for this model. */
  clientRequired: boolean;
};

const BILLING_BEHAVIOUR: Record<BillingModel, BillingBehaviour> = {
  FIXED_PRICE: { billable: true, clientRequired: true },
  TIME_AND_MATERIALS: { billable: true, clientRequired: true },
  RETAINER: { billable: true, clientRequired: true },
  INTERNAL: { billable: false, clientRequired: false },
  NON_BILLABLE: { billable: false, clientRequired: false },
};

/**
 * What a billing model implies, unchanged by the project's status or its client.
 *
 * - `billable`: revenue entries and invoices are expected for this project.
 * - `clientRequired`: the project cannot be saved without naming a client.
 *
 * `INTERNAL` and `NON_BILLABLE` are deliberately not billable: a later report must not
 * invent revenue for them. `NON_BILLABLE` may still name a client (pro bono work);
 * `INTERNAL` work has no client by construction but the database keeps the column
 * optional rather than restricting history.
 */
export function billingBehaviour(model: BillingModel): BillingBehaviour {
  return BILLING_BEHAVIOUR[model];
}

export type ClientSummary = {
  id: string;
  name: string;
  contactName: string | null;
  email: string | null;
  notes: string | null;
  archived: boolean;
  /** Every project linked to this client, archived ones included. */
  projectCount: number;
  /** Projects that are neither archived nor completed. */
  activeProjectCount: number;
};

export type ProjectSummary = {
  id: string;
  name: string;
  clientId: string | null;
  clientName: string | null;
  billingModel: BillingModel;
  status: ProjectStatus;
  currency: Currency;
  startDate: Date | null;
  endDate: Date | null;
  notes: string | null;
  archived: boolean;
};

const NAME_MESSAGE = "Le nom est requis.";
const NAME_MAX_MESSAGE = "Le nom est limité à 120 caractères.";

const clientFields = z.object({
  name: z.string().trim().min(1, NAME_MESSAGE).max(120, NAME_MAX_MESSAGE),
  contactName: optionalText(120, "Le contact est limité à 120 caractères."),
  email: optionalText(160, "L'adresse e-mail est limitée à 160 caractères.").refine(
    (value) => value === null || z.email().safeParse(value).success,
    { message: "Adresse e-mail invalide." },
  ),
  notes: optionalText(2000, "Les notes sont limitées à 2000 caractères."),
});

export const clientInputSchema = clientFields;
export type ClientInput = z.input<typeof clientInputSchema>;
export type ValidatedClientInput = z.output<typeof clientInputSchema>;

/** Same rules plus the identifier, for an in-place edit. */
export const clientUpdateSchema = clientFields.extend({
  id: z.string().trim().min(1, "Identifiant manquant."),
});
export type ClientUpdateInput = z.input<typeof clientUpdateSchema>;

const projectFields = z.object({
  name: z.string().trim().min(1, NAME_MESSAGE).max(120, NAME_MAX_MESSAGE),
  clientId: optionalId,
  billingModel: z.enum(BILLING_MODELS, "Choisissez un modèle de facturation."),
  status: z.enum(PROJECT_STATUSES, "Statut inconnu."),
  currency: currencyCode.default("EUR"),
  startDate: optionalDate,
  endDate: optionalDate,
  notes: optionalText(2000, "Les notes sont limitées à 2000 caractères."),
});

type ProjectFields = z.infer<typeof projectFields>;

/** A billable model needs a client: that is where its revenue will land. */
function clientIsPresent(value: ProjectFields): boolean {
  return !billingBehaviour(value.billingModel).clientRequired || value.clientId !== null;
}

function datesAreOrdered(value: ProjectFields): boolean {
  if (!value.startDate || !value.endDate) {
    return true;
  }

  return value.endDate.getTime() >= value.startDate.getTime();
}

const CLIENT_MESSAGE = "Un projet facturable doit être rattaché à un client.";
const DATES_MESSAGE = "La date de fin doit suivre la date de début.";

export const projectInputSchema = projectFields
  .refine(clientIsPresent, { message: CLIENT_MESSAGE, path: ["clientId"] })
  .refine(datesAreOrdered, { message: DATES_MESSAGE, path: ["endDate"] });
export type ProjectInput = z.input<typeof projectInputSchema>;
export type ValidatedProjectInput = z.output<typeof projectInputSchema>;

/** Same rules plus the identifier, for an in-place edit. */
export const projectUpdateSchema = projectFields
  .extend({ id: z.string().trim().min(1, "Identifiant manquant.") })
  .refine(clientIsPresent, { message: CLIENT_MESSAGE, path: ["clientId"] })
  .refine(datesAreOrdered, { message: DATES_MESSAGE, path: ["endDate"] });
export type ProjectUpdateInput = z.input<typeof projectUpdateSchema>;

/** Payload of an archive or a restore: the row, and the state the owner wants. */
export const archiveInputSchema = z.object({
  id: z.string().trim().min(1, "Identifiant manquant."),
  archived: z.enum(["true", "false"]).transform((value) => value === "true"),
});
export type ArchiveInput = z.input<typeof archiveInputSchema>;

/** A client reduced to strings for the edit form. */
export function toClientFormInitialValues(client: ClientSummary) {
  return {
    id: client.id,
    name: client.name,
    contactName: client.contactName ?? "",
    email: client.email ?? "",
    notes: client.notes ?? "",
  };
}

/** A project reduced to strings for the edit form: no `Date` crosses the boundary. */
export function toProjectFormInitialValues(project: ProjectSummary) {
  return {
    id: project.id,
    name: project.name,
    clientId: project.clientId ?? "",
    billingModel: project.billingModel,
    status: project.status,
    currency: project.currency,
    startDate: project.startDate ? toDateOnlyString(project.startDate) : "",
    endDate: project.endDate ? toDateOnlyString(project.endDate) : "",
    notes: project.notes ?? "",
  };
}
