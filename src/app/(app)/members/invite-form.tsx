"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Field, inputClass, submitClass } from "@/components/ui";
import type { InvitableRole } from "@/modules/identity/invitations";
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
  const router = useRouter();
  const [email, setEmail] = useState("");
  // Member is the least privilege that still lets someone use the workspace; every
  // manager can grant it, so it is always in the list.
  const [role, setRole] = useState<InvitableRole>("MEMBER");
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [invitation, setInvitation] = useState<{ url: string; message: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, startTransition] = useTransition();

  function submit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setError(null);
    setFieldErrors({});
    setCopied(false);

    startTransition(async () => {
      const outcome = await inviteMemberAction({ email, role });

      if (outcome.status !== "ok") {
        setError(outcome.message);
        if (outcome.status === "invalid") {
          setFieldErrors(outcome.fieldErrors);
        }
        return;
      }

      setInvitation({ url: outcome.invitationUrl, message: outcome.message });
      setEmail("");
      router.refresh();
    });
  }

  async function copyLink(): Promise<void> {
    if (!invitation) return;

    try {
      await navigator.clipboard.writeText(invitation.url);
      setCopied(true);
    } catch {
      // The field stays selectable: copying is a comfort, never the only way.
      setCopied(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={submit} className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1">
          <Field label="Adresse e-mail invitée" htmlFor="invite-email" error={fieldErrors.email?.[0]}>
            <input
              id="invite-email"
              type="email"
              required
              autoComplete="off"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className={inputClass}
            />
          </Field>
        </div>

        <div className="sm:w-52">
          <Field label="Rôle" htmlFor="invite-role" error={fieldErrors.role?.[0]}>
            <select
              id="invite-role"
              value={role}
              onChange={(event) => setRole(event.target.value as InvitableRole)}
              className={inputClass + " "}
            >
              {roles.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <button type="submit" disabled={pending} className={submitClass}>
          {pending ? "…" : "Inviter"}
        </button>
      </form>

      {error ? (
        <p className="text-sm text-rose-700 dark:text-rose-400" role="alert">
          {error}
        </p>
      ) : null}

      {invitation ? (
        <div className="flex flex-col gap-2 rounded-md border border-emerald-300 bg-emerald-50 p-3 dark:border-emerald-900 dark:bg-emerald-950">
          <p className="text-sm text-emerald-900 dark:text-emerald-100">{invitation.message}</p>
          <p className="text-xs text-emerald-800 dark:text-emerald-200">
            Aucun e-mail n&apos;est envoyé : copiez ce lien et transmettez-le par un canal de
            confiance. Il ne sera plus affiché.
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              readOnly
              value={invitation.url}
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
