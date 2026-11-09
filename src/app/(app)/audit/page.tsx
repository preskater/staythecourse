import {
  Badge,
  Card,
  EmptyState,
  PageHeader,
  TableShell,
  tdClass,
  thClass,
} from "@/components/ui";
import { requireUser } from "@/lib/auth/guard";
import { formatInstant } from "@/lib/dates";
import {
  AUDIT_ACTIONS,
  AUDIT_RETENTION_DAYS,
  isAuditAction,
  type AuditAction,
  type AuditEntityType,
  type AuditOutcome,
} from "@/modules/audit/domain";
import { AUDIT_EVENT_PAGE_SIZE, listAuditEvents } from "@/modules/audit/repository";

// A trail read at request time: a cached page would hide what just happened.
export const dynamic = "force-dynamic";

const ACTION_LABELS: Record<AuditAction, string> = {
  "export.transactions": "Export des opérations",
  "export.properties": "Export des biens",
  "export.budgets": "Export des budgets",
  "export.goals": "Export des objectifs",
  "export.alerts": "Export des alertes",
  "auth.sign_in": "Connexion",
  "auth.sign_in_refused": "Connexion refusée",
  "auth.sign_out": "Déconnexion",
  "auth.password_change": "Mot de passe modifié",
  "auth.password_change_refused": "Changement de mot de passe refusé",
  "auth.session_revoke": "Session révoquée",
  "transaction.create": "Opération créée",
  "transaction.update": "Opération modifiée",
  "transaction.delete": "Opération supprimée",
  "transaction.transfer": "Virement enregistré",
  "transaction.reconcile": "Pointage modifié",
  "transaction.salary_book": "Salaire enregistré",
  "rate.write": "Taux horaire enregistré",
  "estimate.version_create": "Version de devis créée",
  "estimate.approve": "Version de devis approuvée",
  "module.enable": "Module activé",
  "module.disable": "Module désactivé",
  "integration.connect": "Connexion d'intégration",
  "integration.sync": "Synchronisation",
  "backup.run": "Sauvegarde",
  "restore.run": "Restauration",
};

const ENTITY_LABELS: Record<AuditEntityType, string> = {
  EXPORT: "Export",
  SESSION: "Session",
  USER: "Compte",
  TRANSACTION: "Opération",
  TRANSFER: "Virement",
  SALARY_RATE: "Taux horaire",
  ESTIMATE: "Devis",
  MODULE: "Module",
  INTEGRATION: "Intégration",
  OPERATION: "Opération système",
};

const OUTCOMES: Record<AuditOutcome, { label: string; tone: "positive" | "warning" | "negative" }> = {
  SUCCESS: { label: "Succès", tone: "positive" },
  REFUSED: { label: "Refusé", tone: "warning" },
  FAILED: { label: "Échec", tone: "negative" },
};

/**
 * « Journal » — the append-only audit trail, read-only.
 *
 * Codes, counts, calendar days and entity references only: the metadata was already
 * redacted when the row was written. There is no control here that edits or deletes an
 * entry, and no Server Action exists to do so.
 */
export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const params = await searchParams;
  const requested = typeof params.action === "string" ? params.action : null;
  const actionFilter = isAuditAction(requested) ? requested : null;

  const entries = await listAuditEvents(user.workspace.id, { action: actionFilter });

  return (
    <>
      <PageHeader
        title="Journal d'audit"
        description={
          actionFilter
            ? `Derniers événements « ${ACTION_LABELS[actionFilter]} », du plus récent au plus ancien.`
            : `Derniers événements de sécurité et de modification des données, du plus récent au plus ancien. Conservation : ${AUDIT_RETENTION_DAYS} jours.`
        }
      />

      <Card
        title="Filtrer"
        description="Le journal ne contient ni montant, ni libellé, ni jeton, ni mot de passe : uniquement des codes, des références et des compteurs."
      >
        <form method="get" className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Action</span>
            <select
              name="action"
              defaultValue={actionFilter ?? ""}
              className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            >
              <option value="">Toutes les actions</option>
              {AUDIT_ACTIONS.map((action) => (
                <option key={action} value={action}>
                  {ACTION_LABELS[action]}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            Afficher
          </button>
          {actionFilter ? (
            <a
              href="/audit"
              className="rounded-md px-3 py-1.5 text-sm underline-offset-4 hover:underline"
            >
              Retirer le filtre
            </a>
          ) : null}
        </form>
      </Card>

      <Card
        title="Événements"
        description={`Au plus ${AUDIT_EVENT_PAGE_SIZE} lignes ; les plus anciennes sont supprimées par la tâche de conservation.`}
      >
        {entries.length === 0 ? (
          <EmptyState
            title="Aucun événement"
            description={
              actionFilter
                ? "Aucune entrée pour cette action. Retirez le filtre pour voir le journal complet."
                : "Le journal se remplit à la prochaine connexion ou au prochain changement de données."
            }
          />
        ) : (
          <TableShell caption="Journal d'audit">
            <thead>
              <tr>
                <th className={thClass}>Date</th>
                <th className={thClass}>Action</th>
                <th className={thClass}>Référence</th>
                <th className={thClass}>Résultat</th>
                <th className={thClass}>Acteur</th>
                <th className={thClass}>Détails</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => {
                const outcome = OUTCOMES[entry.outcome];
                const details = Object.entries(entry.metadata)
                  .map(([key, value]) => `${key} : ${String(value)}`)
                  .join(" · ");

                return (
                  <tr key={entry.id}>
                    <td className={tdClass}>{formatInstant(entry.createdAt)}</td>
                    <td className={tdClass}>
                      <span className="font-medium">{ACTION_LABELS[entry.action]}</span>
                      <span className="block text-xs text-zinc-500 dark:text-zinc-400">
                        {entry.action}
                      </span>
                    </td>
                    <td className={tdClass}>
                      {ENTITY_LABELS[entry.entityType]}
                      {entry.entityId ? (
                        <span className="block text-xs text-zinc-500 dark:text-zinc-400">
                          {entry.entityId}
                        </span>
                      ) : null}
                    </td>
                    <td className={tdClass}>
                      <Badge tone={outcome.tone}>{outcome.label}</Badge>
                    </td>
                    <td className={tdClass}>
                      {entry.actorId === null
                        ? "Système"
                        : entry.actorId === user.id
                          ? "Vous"
                          : entry.actorId}
                    </td>
                    <td className={tdClass}>{details || "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </TableShell>
        )}
      </Card>
    </>
  );
}
