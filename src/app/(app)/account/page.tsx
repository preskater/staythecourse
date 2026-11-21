import Link from "next/link";
import {
  Badge,
  Card,
  EmptyState,
  Notice,
  PageHeader,
  TableShell,
  tdClass,
  thClass,
} from "@/components/ui";
import { requireUser } from "@/lib/auth/guard";
import { formatInstant } from "@/lib/dates";
import { PASSWORD_MIN_LENGTH } from "@/modules/identity/domain";
import { listActiveSessions } from "@/modules/identity/sessions";
import { ChangePasswordForm } from "./change-password-form";
import { RevokeOtherSessionsButton, RevokeSessionButton } from "./session-buttons";

export const dynamic = "force-dynamic";

/** Coarse labels only: no user agent is stored or displayed. */
const CLIENT_LABELS = {
  WEB: "Web",
  MOBILE: "Mobile",
  UNKNOWN: "Inconnu",
} as const;

/**
 * Owner account.
 *
 * The only page that changes a credential, and the only one that shows the identity
 * back to its owner: there is no public sign-up, so the address and the name come
 * from the seed script. It is also the only page that lists and revokes sessions.
 * No secret is ever displayed: a session is described by its coarse client label and
 * its dates, never by a token or a user agent.
 */
export default async function AccountPage() {
  const user = await requireUser();
  const sessions = await listActiveSessions(user.id);
  const otherSessionCount = sessions.filter((session) => session.id !== user.sessionId).length;

  // Read at request time: with this flag the seed would overwrite the stored hash at
  // the next restart. Saying so on the page is cheaper than a password that reverts
  // with no explanation.
  const seedForcesPassword = process.env.SEED_OWNER_FORCE_PASSWORD === "true";

  return (
    <>
      <PageHeader
        title="Compte"
        description="Votre adresse, votre nom et votre mot de passe. Aucune inscription publique : un compte est créé par le script de départ ou par une invitation."
        actions={
          <Link
            href="/diagnostics"
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            Diagnostic du système
          </Link>
        }
      />

      {seedForcesPassword ? (
        <Notice tone="warning">
          SEED_OWNER_FORCE_PASSWORD vaut « true » : au prochain démarrage de la pile, le
          script de départ réécrira le mot de passe avec la valeur de SEED_OWNER_PASSWORD.
        </Notice>
      ) : null}

      <Card
        title="Identité"
        description="Le compte de départ vient de SEED_OWNER_EMAIL et SEED_OWNER_NAME ; un compte invité reprend l'adresse de l'invitation. Ces valeurs ne se modifient pas depuis cette page."
      >
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
              Adresse e-mail
            </dt>
            <dd className="mt-0.5 font-medium">{user.email}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
              Nom affiché
            </dt>
            <dd className="mt-0.5 font-medium">{user.name ?? "Non renseigné"}</dd>
          </div>
        </dl>
      </Card>

      <Card
        title="Sessions actives"
        description="Chaque appareil connecté détient un jeton. Révoquer une session la refuse dès la requête suivante. Aucun jeton ni agent utilisateur n'est affiché."
      >
        {sessions.length === 0 ? (
          <EmptyState
            title="Aucune session active"
            description="Reconnectez-vous : cette liste doit toujours contenir la session en cours."
          />
        ) : (
          <>
            <TableShell caption="Sessions actives">
              <thead>
                <tr>
                  <th className={thClass}>Client</th>
                  <th className={thClass}>Créée le</th>
                  <th className={thClass}>Dernière activité</th>
                  <th className={thClass}>Action</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((session) => {
                  const isCurrent = session.id === user.sessionId;

                  return (
                    <tr key={session.id}>
                      <td className={tdClass}>
                        <span className="flex flex-wrap items-center gap-2">
                          {CLIENT_LABELS[session.client]}
                          {isCurrent ? <Badge tone="positive">Session actuelle</Badge> : null}
                        </span>
                      </td>
                      <td className={tdClass}>{formatInstant(session.createdAt)}</td>
                      <td className={tdClass}>{formatInstant(session.lastSeenAt)}</td>
                      <td className={tdClass}>
                        {isCurrent ? (
                          <span className="text-xs text-zinc-500 dark:text-zinc-400">
                            Utilisez « Se déconnecter » pour fermer cette session.
                          </span>
                        ) : (
                          <RevokeSessionButton sessionId={session.id} />
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </TableShell>

            <div className="mt-3">
              <RevokeOtherSessionsButton otherCount={otherSessionCount} />
            </div>
          </>
        )}
      </Card>

      <Card
        title="Mot de passe"
        description={`Au moins ${PASSWORD_MIN_LENGTH} caractères. Le mot de passe actuel est demandé, et un changement déconnecte toutes les sessions.`}
      >
        <ChangePasswordForm />
      </Card>
    </>
  );
}
