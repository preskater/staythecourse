"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { ActionResult } from "@/lib/actions";
import type { InvitableRole } from "@/modules/identity/invitations";
import type { WorkspaceRole } from "@/modules/identity/workspace";
import {
  changeMemberRoleAction,
  removeMemberAction,
  revokeInvitationAction,
  transferOwnershipAction,
} from "./actions";

/**
 * One pending state per control, sharing the refresh path.
 *
 * The action is the guard: a refused choice writes nothing and the message it returns
 * is the same one a forged POST would get. The interface only decides what is worth
 * offering.
 */
function useMemberAction() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function run(action: () => Promise<ActionResult>): void {
    setError(null);
    setMessage(null);

    startTransition(async () => {
      const outcome = await action();

      if (outcome.status !== "ok") {
        setError(outcome.message);
        return;
      }

      setMessage(outcome.message ?? null);
      router.refresh();
    });
  }

  return { error, message, pending, run };
}

function Feedback({ error, message }: { error: string | null; message: string | null }) {
  if (!error && !message) return null;

  return (
    <span
      className={`text-xs ${error ? "text-rose-700 dark:text-rose-400" : "text-emerald-700 dark:text-emerald-400"}`}
      role={error ? "alert" : "status"}
    >
      {error ?? message}
    </span>
  );
}

export function MemberRoleForm({
  userId,
  currentRole,
  roles,
}: {
  userId: string;
  currentRole: WorkspaceRole;
  roles: readonly { value: InvitableRole; label: string }[];
}) {
  const { error, message, pending, run } = useMemberAction();
  const [role, setRole] = useState<InvitableRole>(() =>
    roles.some((option) => option.value === currentRole)
      ? (currentRole as InvitableRole)
      : (roles[0]?.value ?? "MEMBER"),
  );

  if (roles.length === 0) {
    return null;
  }

  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        run(() => changeMemberRoleAction({ userId, role }));
      }}
    >
      <select
        aria-label="Nouveau rôle"
        value={role}
        onChange={(event) => setRole(event.target.value as InvitableRole)}
        className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm h-full dark:border-zinc-700 dark:bg-zinc-900"
      >
        {roles.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <button
        type="submit"
        disabled={pending || role === currentRole}
        className="rounded-md border border-zinc-300 px-2 py-1 text-sm hover:bg-zinc-100 disabled:opacity-60 dark:border-zinc-700 dark:hover:bg-zinc-800"
      >
        {pending ? "…" : "Enregistrer"}
      </button>
      <Feedback error={error} message={message} />
    </form>
  );
}

export function RemoveMemberButton({
  userId,
  memberLabel,
}: {
  userId: string;
  memberLabel: string;
}) {
  const { error, message, pending, run } = useMemberAction();

  return (
    <span className="flex flex-wrap items-center gap-1">
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          if (
            !window.confirm(
              `Retirer « ${memberLabel} » de cet espace ? Ses données restent dans l'espace ; son accès s'arrête à sa prochaine requête.`,
            )
          ) {
            return;
          }

          run(() => removeMemberAction({ userId }));
        }}
        className="rounded-md border border-rose-300 px-2 py-1 text-sm text-rose-700 hover:bg-rose-50 disabled:opacity-60 dark:border-rose-900 dark:text-rose-400 dark:hover:bg-rose-950"
      >
        {pending ? "…" : "Retirer"}
      </button>
      <Feedback error={error} message={message} />
    </span>
  );
}

export function TransferOwnershipButton({
  userId,
  memberLabel,
}: {
  userId: string;
  memberLabel: string;
}) {
  const { error, message, pending, run } = useMemberAction();

  return (
    <span className="flex flex-wrap items-center gap-1">
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          if (
            !window.confirm(
              `Transférer la propriété de l'espace à « ${memberLabel} » ? Vous deviendrez administrateur et cette action ne peut pas être annulée depuis cette page.`,
            )
          ) {
            return;
          }

          run(() => transferOwnershipAction({ userId }));
        }}
        className="rounded-md border border-amber-300 px-2 py-1 text-sm text-amber-800 hover:bg-amber-50 disabled:opacity-60 dark:border-amber-900 dark:text-amber-300 dark:hover:bg-amber-950"
      >
        {pending ? "…" : "Transférer la propriété"}
      </button>
      <Feedback error={error} message={message} />
    </span>
  );
}

export function RevokeInvitationButton({ invitationId }: { invitationId: string }) {
  const { error, message, pending, run } = useMemberAction();

  return (
    <span className="flex flex-col gap-1">
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          if (!window.confirm("Révoquer cette invitation ? Le lien ne fonctionnera plus.")) {
            return;
          }

          run(() => revokeInvitationAction({ invitationId }));
        }}
        className="rounded-md border border-rose-300 px-2 py-1 text-sm text-rose-700 hover:bg-rose-50 disabled:opacity-60 dark:border-rose-900 dark:text-rose-400 dark:hover:bg-rose-950"
      >
        {pending ? "…" : "Révoquer"}
      </button>
      <Feedback error={error} message={message} />
    </span>
  );
}
