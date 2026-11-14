"use client";

import { useState, useTransition } from "react";
import { Field, inputClass, submitClass } from "@/components/ui";
import { acceptInvitationAction } from "./actions";

/**
 * Signed-out acceptance: create the invited account, or sign in to the existing one.
 *
 * The address is fixed by the invitation and shown read-only; the browser cannot
 * replace it. A successful action signs in and redirects, so no success state is kept.
 */
export function AcceptInvitationForm({ token, email }: { token: string; email: string }) {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [pending, startTransition] = useTransition();

  function submit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setError(null);
    setFieldErrors({});

    startTransition(async () => {
      const outcome = await acceptInvitationAction({ token, password, name });

      if (outcome.status === "ok") {
        return;
      }

      setError(outcome.message);
      if (outcome.status === "invalid") {
        setFieldErrors(outcome.fieldErrors);
      }
    });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        Adresse invitée : <strong className="text-zinc-900 dark:text-zinc-100">{email}</strong>.
        Si un compte existe déjà pour cette adresse, saisissez son mot de passe ; sinon,
        un compte est créé avec ce mot de passe.
      </p>

      <Field
        label="Nom affiché (facultatif)"
        htmlFor="accept-name"
        error={fieldErrors.name?.[0]}
        hint="Utilisé seulement si un compte est créé."
      >
        <input
          id="accept-name"
          type="text"
          autoComplete="name"
          maxLength={100}
          value={name}
          onChange={(event) => setName(event.target.value)}
          className={inputClass}
        />
      </Field>

      <Field
        label="Mot de passe"
        htmlFor="accept-password"
        error={fieldErrors.password?.[0]}
        hint="Au moins 12 caractères pour un nouveau compte, et 72 octets au maximum."
      >
        <input
          id="accept-password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className={inputClass}
        />
      </Field>

      {error ? (
        <p className="text-sm text-rose-700 dark:text-rose-400" role="alert">
          {error}
        </p>
      ) : null}

      <button type="submit" disabled={pending} className={submitClass}>
        {pending ? "…" : "Rejoindre l'espace"}
      </button>
    </form>
  );
}
