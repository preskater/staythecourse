import type { Metadata } from "next";
import Link from "next/link";
import { Notice } from "@/components/ui";
import { signOutAction } from "@/app/login/actions";
import { getSessionUser } from "@/lib/auth/guard";
import {
  hashInvitationToken,
  invitationStatus,
  invitationTokenSchema,
} from "@/modules/identity/invitations";
import {
  findWorkspaceInvitationByTokenHash,
  normaliseEmail,
} from "@/modules/identity/repository";
import type { WorkspaceRole } from "@/modules/identity/workspace";
import { AcceptInvitationForm } from "./accept-form";
import { acceptInvitationAsSignedInAction } from "./actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Invitation — Tableau de bord",
  robots: { index: false, follow: false },
  // The token is in the path: never leak it through a Referer header.
  referrer: "no-referrer",
};

const ROLE_LABELS: Record<WorkspaceRole, string> = {
  OWNER: "Propriétaire",
  ADMIN: "Administrateur",
  MEMBER: "Membre",
  VIEWER: "Lecture seule",
};

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-6 px-6 py-16">
      {children}
    </main>
  );
}

/** One answer for unknown, expired, revoked and already-used links. */
function InvalidInvitation() {
  return (
    <Shell>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Invitation indisponible</h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Cette invitation est invalide, expirée, révoquée ou a déjà été utilisée.
        </p>
      </div>
      <Notice tone="warning">
        Demandez une nouvelle invitation à un membre de l&apos;espace. Aucun compte
        n&apos;est créé par cette page sans invitation valide.
      </Notice>
      <Link href="/login" className="text-sm underline underline-offset-4">
        Aller à la page de connexion
      </Link>
    </Shell>
  );
}

/**
 * Public invitation page.
 *
 * The token in the path is a bearer secret. The page shows the workspace name and the
 * invited address (which the link holder already knows), never the inviter or any
 * other member. A signed-in account whose address matches can accept in one click;
 * everyone else uses the password form, which creates the account only when the
 * invited address has none.
 */
export default async function InvitationPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const parsedToken = invitationTokenSchema.safeParse(token);
  if (!parsedToken.success) {
    return <InvalidInvitation />;
  }

  const invitation = await findWorkspaceInvitationByTokenHash(
    hashInvitationToken(parsedToken.data),
  );

  if (!invitation || invitationStatus(invitation) !== "PENDING") {
    return <InvalidInvitation />;
  }

  const user = await getSessionUser();
  const sameAccount = user !== null && normaliseEmail(user.email) === invitation.email;

  return (
    <Shell>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Rejoindre « {invitation.workspaceName} »
        </h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Invitation pour <strong>{invitation.email}</strong>, avec le rôle{" "}
          {ROLE_LABELS[invitation.role]}. Ce lien est valable une seule fois.
        </p>
      </div>

      {sameAccount ? (
        <form action={acceptInvitationAsSignedInAction} className="flex flex-col gap-3">
          <Notice tone="info">
            Vous êtes connecté avec l&apos;adresse invitée. Vous pouvez rejoindre
            l&apos;espace directement.
          </Notice>
          <input type="hidden" name="token" value={parsedToken.data} />
          <button
            type="submit"
            className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
          >
            Rejoindre l&apos;espace
          </button>
        </form>
      ) : user ? (
        <>
          <Notice tone="error">
            Cette invitation a été créée pour une autre adresse. Déconnectez-vous, puis
            rouvrez ce lien : le compte invité pourra l&apos;accepter.
          </Notice>
          <form action={signOutAction}>
            <button
              type="submit"
              className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
            >
              Se déconnecter
            </button>
          </form>
        </>
      ) : (
        <AcceptInvitationForm token={parsedToken.data} email={invitation.email} />
      )}

      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        Aucune inscription publique : un compte ne peut être créé que par une invitation
        valide, transmise manuellement par un membre de l&apos;espace.
      </p>
    </Shell>
  );
}
