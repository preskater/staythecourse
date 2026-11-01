"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect } from "react";
import { useForm, useWatch } from "react-hook-form";
import { FormFeedback, SubmitButton, useRecordedAction } from "@/components/forms";
import { Field, Notice, inputClass } from "@/components/ui";
import { SUPPORTED_CURRENCIES } from "@/lib/money";
import {
  BILLING_MODELS,
  BILLING_MODEL_LABELS,
  billingBehaviour,
  PROJECT_STATUSES,
  PROJECT_STATUS_LABELS,
  projectInputSchema,
  type BillingModel,
  type ProjectInput,
  type ProjectStatus,
} from "@/modules/micro-business/domain";
import { createProjectAction, updateProjectAction } from "./actions";

/** String-only initial values: a client component never receives a `Date`. */
export type ProjectFormValues = {
  id: string;
  name: string;
  clientId: string;
  billingModel: string;
  status: string;
  currency: string;
  startDate: string;
  endDate: string;
  notes: string;
};

export type ClientOption = {
  id: string;
  name: string;
  archived: boolean;
};

const EMPTY: Omit<ProjectFormValues, "id"> = {
  name: "",
  clientId: "",
  billingModel: "FIXED_PRICE",
  status: "ACTIVE",
  currency: "EUR",
  startDate: "",
  endDate: "",
  notes: "",
};

function formDefaults(project?: ProjectFormValues | null): ProjectInput {
  const values = project ?? EMPTY;

  return {
    name: values.name,
    clientId: values.clientId,
    billingModel: values.billingModel as BillingModel,
    status: values.status as ProjectStatus,
    currency: values.currency,
    startDate: values.startDate,
    endDate: values.endDate,
    notes: values.notes,
  };
}

/**
 * Creates or edits a project.
 *
 * The billing model is a first-class choice: with a billable model the form requires a
 * client, because that is where the project's revenue will be recognised. An internal
 * or non-billable project may stay without one. The currency is the project's own
 * reference currency; nothing is ever converted.
 */
export function ProjectForm({
  clients,
  project,
}: {
  clients: ClientOption[];
  project?: ProjectFormValues | null;
}) {
  const form = useForm<ProjectInput>({
    resolver: zodResolver(projectInputSchema, undefined, { raw: true }),
    defaultValues: formDefaults(project),
  });

  const { result, submit } = useRecordedAction(form, (values) =>
    project?.id ? updateProjectAction({ ...values, id: project.id }) : createProjectAction(values),
  );
  const { errors, isSubmitting } = form.formState;

  const billingModel = useWatch({ control: form.control, name: "billingModel" });
  const clientRequired = billingBehaviour(billingModel as BillingModel).clientRequired;

  useEffect(() => {
    form.reset(formDefaults(project));
  }, [project, form]);

  return (
    <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" noValidate>
      <Field label="Nom du projet" htmlFor="project-name" error={errors.name?.message}>
        <input
          id="project-name"
          className={inputClass}
          autoComplete="off"
          {...form.register("name")}
        />
      </Field>

      <Field
        label="Client"
        htmlFor="project-client"
        error={errors.clientId?.message}
        hint={clientRequired ? "Requis pour un projet facturable." : "Facultatif."}
      >
        <select id="project-client" className={inputClass} {...form.register("clientId")}>
          <option value="">Aucun client</option>
          {clients.map((client) => (
            <option key={client.id} value={client.id}>
              {client.name}
              {client.archived ? " (archivé)" : ""}
            </option>
          ))}
        </select>
      </Field>

      <Field
        label="Modèle de facturation"
        htmlFor="project-billing"
        error={errors.billingModel?.message}
      >
        <select id="project-billing" className={inputClass} {...form.register("billingModel")}>
          {BILLING_MODELS.map((model) => (
            <option key={model} value={model}>
              {BILLING_MODEL_LABELS[model]}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Statut" htmlFor="project-status" error={errors.status?.message}>
        <select id="project-status" className={inputClass} {...form.register("status")}>
          {PROJECT_STATUSES.map((status) => (
            <option key={status} value={status}>
              {PROJECT_STATUS_LABELS[status]}
            </option>
          ))}
        </select>
      </Field>

      <Field
        label="Devise"
        htmlFor="project-currency"
        error={errors.currency?.message}
        hint="Devise de référence du projet, jamais convertie."
      >
        <select id="project-currency" className={inputClass} {...form.register("currency")}>
          {SUPPORTED_CURRENCIES.map((currency) => (
            <option key={currency} value={currency}>
              {currency}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Début" htmlFor="project-start" error={errors.startDate?.message} hint="Facultatif.">
        <input
          id="project-start"
          type="date"
          className={inputClass}
          {...form.register("startDate")}
        />
      </Field>

      <Field
        label="Fin"
        htmlFor="project-end"
        error={errors.endDate?.message}
        hint="Facultatif, jamais avant le début."
      >
        <input id="project-end" type="date" className={inputClass} {...form.register("endDate")} />
      </Field>

      <Field label="Notes" htmlFor="project-notes" error={errors.notes?.message} hint="Facultatif.">
        <input
          id="project-notes"
          className={inputClass}
          autoComplete="off"
          {...form.register("notes")}
        />
      </Field>

      {clientRequired && clients.length === 0 ? (
        <div className="sm:col-span-2 lg:col-span-3">
          <Notice tone="warning">
            Aucun client n&apos;est enregistré : ajoutez-en un, ou choisissez un modèle interne ou
            non facturable.
          </Notice>
        </div>
      ) : null}

      <div className="sm:col-span-2 lg:col-span-3">
        <SubmitButton
          label={project?.id ? "Enregistrer le projet" : "Ajouter le projet"}
          pending={isSubmitting}
        />
      </div>

      <div className="sm:col-span-2 lg:col-span-3">
        <FormFeedback
          result={result}
          successMessage={project?.id ? "Projet mis à jour." : "Projet ajouté."}
        />
      </div>
    </form>
  );
}
