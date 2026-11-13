import type { Metadata } from "next";
import { Notice } from "@/components/ui";
import { loginAction } from "./actions";

export const metadata: Metadata = {
  title: "Connexion — Tableau de bord",
  robots: { index: false, follow: false },
};

const ERROR_MESSAGES: Record<string, string> = {
  credentials: "Adresse e-mail ou mot de passe incorrect.",
  invalid: "Renseignez une adresse e-mail et un mot de passe.",
};

/** Confirmation shown after a password change, which signs every session out. */
const PASSWORD_CHANGED_MESSAGE =
  "Mot de passe modifié. Toutes les sessions ont été déconnectées : connectez-vous avec le nouveau mot de passe.";

/**
 * Auth.js sends both `error=CredentialsSignin` and a machine-readable `code`.
 * The code is preferred, so the message does not depend on a display string.
 *
 * `changed` is ours rather than Auth.js's: it is how the Compte page reports a
 * successful change without leaving the owner on a page they can no longer use.
 */
function resolveNotice(params: {
  error?: string;
  code?: string;
  changed?: string;
}): { tone: "info" | "error"; message: string } | null {
  if (params.changed) {
    return { tone: "info", message: PASSWORD_CHANGED_MESSAGE };
  }

  const key = params.code ?? params.error;
  if (!key) {
    return null;
  }

  const normalised = key === "CredentialsSignin" ? "credentials" : key;
  return { tone: "error", message: ERROR_MESSAGES[normalised] ?? "Connexion impossible." };
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; code?: string; changed?: string }>;
}) {
  const params = await searchParams;
  const notice = resolveNotice(params);

  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-6 py-16">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Tableau de bord</h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Accès réservé aux membres d&apos;un espace. Aucune inscription publique.
        </p>
      </div>

      {notice ? <Notice tone={notice.tone}>{notice.message}</Notice> : null}

      <form action={loginAction} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <label htmlFor="email" className="text-sm font-medium">
            Adresse e-mail
          </label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="username"
            required
            className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="password" className="text-sm font-medium">
            Mot de passe
          </label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
        </div>

        <button
          type="submit"
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
        >
          Se connecter
        </button>
      </form>

      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        Un compte est créé par le script de départ (<code>npm run db:seed</code>) ou par
        une invitation, jamais depuis cette page.
      </p>
    </main>
  );
}
