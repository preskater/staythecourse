"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useForm, useWatch } from "react-hook-form";
import { FormFeedback, SubmitButton, useRecordedAction } from "@/components/forms";
import { Field, inputClass } from "@/components/ui";
import {
  MAPPING_SELECTOR_LABELS,
  MAPPING_SELECTORS,
  projectMappingInputSchema,
  type ProjectMappingFormValues,
} from "@/modules/micro-business/mapping";
import { createProjectMappingAction } from "../mapping-actions";

const VALUE_HINTS: Record<string, string> = {
  PATH_PREFIX: "Dossier du dépôt, ex. apps/web",
  BRANCH: "Nom exact, ex. client-acme",
  LABEL: "Nom de l'étiquette, ex. acme",
  MILESTONE: "Titre exact du jalon",
  REPOSITORY: "Sans objet : tout le dépôt",
};

/** Adds one mapping: a selector of a repository → a project. */
export function MappingForm({
  projects,
  repositories,
}: {
  projects: { id: string; name: string }[];
  repositories: string[];
}) {
  const form = useForm<ProjectMappingFormValues>({
    resolver: zodResolver(projectMappingInputSchema, undefined, { raw: true }),
    defaultValues: { projectId: projects[0]?.id ?? "", repository: "", selector: "REPOSITORY", value: "" },
  });
  const { result, submit } = useRecordedAction(form, (values) => createProjectMappingAction(values));
  const { errors, isSubmitting } = form.formState;
  const selector = useWatch({ control: form.control, name: "selector" });

  return (
    <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" noValidate>
      <Field label="Dépôt" htmlFor="mapping-repository" error={errors.repository?.message} hint="propriétaire/nom">
        <input id="mapping-repository" list="mapping-repositories" className={inputClass} autoComplete="off" {...form.register("repository")} />
        <datalist id="mapping-repositories">
          {repositories.map((repository) => (
            <option key={repository} value={repository} />
          ))}
        </datalist>
      </Field>
      <Field label="Sélecteur" htmlFor="mapping-selector" error={errors.selector?.message}>
        <select id="mapping-selector" className={inputClass} {...form.register("selector")}>
          {MAPPING_SELECTORS.map((value) => (
            <option key={value} value={value}>
              {MAPPING_SELECTOR_LABELS[value]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Valeur" htmlFor="mapping-value" error={errors.value?.message} hint={VALUE_HINTS[selector]}>
        <input id="mapping-value" className={inputClass} autoComplete="off" readOnly={selector === "REPOSITORY"} {...form.register("value")} />
      </Field>
      <Field label="Projet" htmlFor="mapping-project" error={errors.projectId?.message}>
        <select id="mapping-project" className={inputClass} {...form.register("projectId")}>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </Field>
      <div className="flex flex-col gap-2 sm:col-span-2 lg:col-span-4">
        <SubmitButton label="Ajouter la règle" pending={isSubmitting} />
        <FormFeedback result={result} successMessage="Règle ajoutée." />
      </div>
    </form>
  );
}
