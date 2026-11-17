"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { FormFeedback, SubmitButton, useRecordedAction } from "@/components/forms";
import { Field, inputClass } from "@/components/ui";
import { clientInputSchema, type ClientInput } from "@/modules/micro-business/domain";
import { createClientAction, updateClientAction } from "./actions";

/** String-only initial values: the id is not part of the validated creation payload. */
export type ClientFormValues = {
  id: string;
  name: string;
  contactName: string;
  email: string;
  notes: string;
};

const EMPTY: Omit<ClientFormValues, "id"> = {
  name: "",
  contactName: "",
  email: "",
  notes: "",
};

function formDefaults(client?: ClientFormValues | null): ClientInput {
  const values = client ?? EMPTY;

  return {
    name: values.name,
    contactName: values.contactName,
    email: values.email,
    notes: values.notes,
  };
}

/**
 * Creates or edits a client.
 *
 * An archived client can still be edited: archiving hides it from the entry forms, it
 * does not freeze its details.
 */
export function ClientForm({ client }: { client?: ClientFormValues | null }) {
  const form = useForm<ClientInput>({
    resolver: zodResolver(clientInputSchema, undefined, { raw: true }),
    defaultValues: formDefaults(client),
  });

  const { result, submit } = useRecordedAction(form, (values) =>
    client?.id ? updateClientAction({ ...values, id: client.id }) : createClientAction(values),
  );
  const { errors, isSubmitting } = form.formState;

  useEffect(() => {
    form.reset(formDefaults(client));
  }, [client, form]);

  return (
    <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2" noValidate>
      <Field label="Nom du client" htmlFor="client-name" error={errors.name?.message}>
        <input id="client-name" className={inputClass} autoComplete="off" {...form.register("name")} />
      </Field>

      <Field
        label="Contact"
        htmlFor="client-contact"
        error={errors.contactName?.message}
        hint="Facultatif."
      >
        <input
          id="client-contact"
          className={inputClass}
          autoComplete="off"
          {...form.register("contactName")}
        />
      </Field>

      <Field label="E-mail" htmlFor="client-email" error={errors.email?.message} hint="Facultatif.">
        <input
          id="client-email"
          type="email"
          className={inputClass}
          autoComplete="off"
          {...form.register("email")}
        />
      </Field>

      <Field label="Notes" htmlFor="client-notes" error={errors.notes?.message} hint="Facultatif.">
        <input
          id="client-notes"
          className={inputClass}
          autoComplete="off"
          {...form.register("notes")}
        />
      </Field>

      <div className="sm:col-span-2">
        <SubmitButton label={client?.id ? "Enregistrer le client" : "Ajouter le client"} pending={isSubmitting} />
      </div>

      <div className="sm:col-span-2">
        <FormFeedback result={result} successMessage={client?.id ? "Client mis à jour." : "Client ajouté."} />
      </div>
    </form>
  );
}
