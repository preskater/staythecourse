"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { FormFeedback, SubmitButton, useRecordedAction } from "@/components/forms";
import { Field, inputClass } from "@/components/ui";
import {
  inviteMemberSchema,
  type InviteMemberInput,
  type InvitableRole,
} from "@/modules/identity/domain";
import { inviteMemberAction } from "./actions";

export type InvitableRoleOption = {
  value: InvitableRole;
  label: string;
};

/**
 * Creates one invitation and shows its link once.
 *
 * The link is the only copy of the token: the database stores a digest, so a link
 * lost here can only be replaced by a new invitation (which revokes the old one).
 */
export function InviteMemberForm({ roles }: { roles: readonly InvitableRoleOption[] }) {
  const form = useForm<InviteMemberInput>({
    resolver: zodResolver(inviteMemberSchema, undefined, { raw: true }),
    // Member is the least privilege that still lets someone use the workspace; every
    // manager can grant it, so it is always in the list.
    defaultValues: { email: "", role: "MEMBER" },
  });
  // Lifted out of the shared result: the link is what this form exists to show, and
  // it only exists on success.
  const [invitationUrl, setInvitationUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const { result, submit } = useRecordedAction(form, async (values) => {
    const outcome = await inviteMemberAction(values);
    setInvitationUrl(outcome.status === "ok" ? outcome.invitationUrl : null);
    setCopied(false);
    return outcome;
  });
  const { errors, isSubmitting } = form.formState;

  async function copyLink(): Promise<void> {
    if (!invitationUrl) return;

    try {
      await navigator.clipboard.writeText(invitationUrl);
      setCopied(true);
    } catch {
      // The field stays selectable: copying is a comfort, never the only way.
      setCopied(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={submit} className="flex flex-col gap-3 sm:flex-row sm:items-end" noValidate>
        <div className="flex-1">
          <Field label="Adresse e-mail invitée" htmlFor="invite-email" error={errors.email?.message}>
            <input
              id="invite-email"
              type="email"
              autoComplete="off"
              className={inputClass}
              {...form.register("email")}
            />
          </Field>
        </div>

        <div className="sm:w-52">
          <Field label="Rôle" htmlFor="invite-role" error={errors.role?.message}>
            <select id="invite-role" className={inputClass} {...form.register("role")}>
              {roles.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <SubmitButton label="Inviter" pending={isSubmitting} />
      </form>

      <FormFeedback result={result} successMessage="Invitation créée." />

      {invitationUrl ? (
        <div className="flex flex-col gap-2 rounded-md border border-emerald-300 bg-emerald-50 p-3 dark:border-emerald-900 dark:bg-emerald-950">
          <p className="text-xs text-emerald-800 dark:text-emerald-200">
            Aucun e-mail n&apos;est envoyé : copiez ce lien et transmettez-le par un canal de
            confiance. Il ne sera plus affiché.
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              readOnly
              value={invitationUrl}
              aria-label="Lien d'invitation"
              onFocus={(event) => event.currentTarget.select()}
              className={`${inputClass} font-mono text-xs`}
            />
            <button
              type="button"
              onClick={copyLink}
              className="rounded-md border border-emerald-400 px-3 py-1.5 text-sm text-emerald-900 hover:bg-emerald-100 dark:border-emerald-800 dark:text-emerald-100 dark:hover:bg-emerald-900"
            >
              {copied ? "Lien copié" : "Copier le lien"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
