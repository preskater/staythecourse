"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { FormFeedback, SubmitButton, useRecordedAction } from "@/components/forms";
import { Field, inputClass } from "@/components/ui";
import {
  acceptInvitationSchema,
  type AcceptInvitationInput,
} from "@/modules/identity/domain";
import { acceptInvitationAction } from "./actions";

/**
 * Signed-out acceptance: create the invited account, or sign in to the existing one.
 *
 * The address is fixed by the invitation and shown read-only; the browser cannot
 * replace it. A successful action signs in and redirects, so no success state is kept.
 */
export function AcceptInvitationForm({ token, email }: { token: string; email: string }) {
  const form = useForm<AcceptInvitationInput>({
    resolver: zodResolver(acceptInvitationSchema, undefined, { raw: true }),
    defaultValues: { token, password: "", name: "" },
  });
  const { result, submit } = useRecordedAction(form, acceptInvitationAction);
  const { errors, isSubmitting } = form.formState;

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      <input type="hidden" {...form.register("token")} />

      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        Adresse invitée : <strong className="text-zinc-900 dark:text-zinc-100">{email}</strong>.
        Si un compte existe déjà pour cette adresse, saisissez son mot de passe ; sinon,
        un compte est créé avec ce mot de passe.
      </p>

      <Field
        label="Nom affiché (facultatif)"
        htmlFor="accept-name"
        error={errors.name?.message}
        hint="Utilisé seulement si un compte est créé."
      >
        <input
          id="accept-name"
          type="text"
          autoComplete="name"
          className={inputClass}
          {...form.register("name")}
        />
      </Field>

      <Field
        label="Mot de passe"
        htmlFor="accept-password"
        error={errors.password?.message}
        hint="Au moins 12 caractères pour un nouveau compte, et 72 octets au maximum."
      >
        <input
          id="accept-password"
          type="password"
          autoComplete="current-password"
          className={inputClass}
          {...form.register("password")}
        />
      </Field>

      <SubmitButton label="Rejoindre l'espace" pending={isSubmitting} />

      <FormFeedback result={result} successMessage="Invitation acceptée." />
    </form>
  );
}
