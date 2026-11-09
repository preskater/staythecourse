"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { FormFeedback, SubmitButton, useRecordedAction } from "@/components/forms";
import { Field, inputClass } from "@/components/ui";
import {
  ESTIMATE_VERSION_KINDS,
  ESTIMATE_VERSION_KIND_LABELS,
  estimateVersionInputSchema,
  type EstimateVersionInput,
} from "@/modules/micro-business/estimates";
import { createEstimateVersionAction } from "../estimate-actions";

export type EstimateProjectOption = {
  id: string;
  name: string;
  currency: string;
};

/**
 * Creates a new estimate version.
 *
 * Versions are immutable, so this form only ever adds one. The first version of a
 * project is the baseline; later ones are revisions or change requests. Lines are
 * entered as `Libellé | montant`, one per line, and a negative amount states a
 * reduction explicitly.
 */
export function EstimateForm({ projects }: { projects: EstimateProjectOption[] }) {
  const form = useForm<EstimateVersionInput>({
    resolver: zodResolver(estimateVersionInputSchema, undefined, { raw: true }),
    defaultValues: {
      projectId: "",
      kind: "BASELINE",
      assumptions: "",
      notes: "",
      items: "",
    },
  });

  const { result, submit } = useRecordedAction(form, (values) =>
    createEstimateVersionAction(values),
  );
  const { errors, isSubmitting } = form.formState;

  return (
    <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2" noValidate>
      <Field
        label="Projet"
        htmlFor="estimate-project"
        error={errors.projectId?.message}
        hint="Seuls les projets non archivés sont proposés."
      >
        <select id="estimate-project" className={inputClass} {...form.register("projectId")}>
          <option value="">Choisir un projet…</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name} ({project.currency})
            </option>
          ))}
        </select>
      </Field>

      <Field
        label="Type de version"
        htmlFor="estimate-kind"
        error={errors.kind?.message}
        hint="La première version est le devis initial ; les suivantes sont des révisions ou des demandes de changement."
      >
        <select id="estimate-kind" className={inputClass} {...form.register("kind")}>
          {ESTIMATE_VERSION_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {ESTIMATE_VERSION_KIND_LABELS[kind]}
            </option>
          ))}
        </select>
      </Field>

      <div className="sm:col-span-2">
        <Field
          label="Lignes du devis"
          htmlFor="estimate-items"
          error={errors.items?.message}
          hint="Une ligne par élément, au format « Libellé | montant ». Un montant négatif exprime une réduction. Les libellés doivent être uniques."
        >
          <textarea
            id="estimate-items"
            className={`${inputClass} min-h-32 font-mono`}
            rows={7}
            placeholder={"Développement | 12 000,00\nDesign | 3 500,00\nRéduction de périmètre | -1 500,00"}
            {...form.register("items")}
          />
        </Field>
      </div>

      <div className="sm:col-span-2">
        <Field
          label="Hypothèses"
          htmlFor="estimate-assumptions"
          error={errors.assumptions?.message}
          hint="Facultatif : ce qui doit rester vrai pour que le devis tienne."
        >
          <textarea
            id="estimate-assumptions"
            className={`${inputClass} min-h-20`}
            rows={3}
            {...form.register("assumptions")}
          />
        </Field>
      </div>

      <div className="sm:col-span-2">
        <Field label="Notes" htmlFor="estimate-notes" error={errors.notes?.message}>
          <input
            id="estimate-notes"
            className={inputClass}
            autoComplete="off"
            {...form.register("notes")}
          />
        </Field>
      </div>

      <div className="sm:col-span-2">
        <SubmitButton label="Enregistrer la version" pending={isSubmitting} />
      </div>

      <div className="sm:col-span-2">
        <FormFeedback result={result} successMessage="Version enregistrée en brouillon." />
      </div>
    </form>
  );
}
