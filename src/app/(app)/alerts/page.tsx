import { Badge, Card, EmptyState, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth/guard";
import { formatInstant } from "@/lib/dates";
import {
  ALERT_STATUS_LABELS,
  describeAlert,
  isAlertVisible,
  resolveAlertRules,
  toAlertRulesFormValues,
  type AlertStatus,
} from "@/modules/alerts/domain";
import { refreshAlerts } from "@/modules/alerts/refresh";
import { listAlertRules, listAlerts, type AlertRecord } from "@/modules/alerts/repository";
import { DismissAlertButton } from "./dismiss-alert-button";
import { RefreshAlertsButton } from "./refresh-alerts-button";
import { RulesForm } from "./rules-form";

// Warnings must reflect the data of the moment, never a static cache.
export const dynamic = "force-dynamic";

const STATUS_TONES: Record<AlertStatus, "warning" | "neutral" | "positive"> = {
  ACTIVE: "warning",
  DISMISSED: "neutral",
  RESOLVED: "positive",
};

/**
 * « Alertes » — where the engine reports what it found.
 *
 * Opening the page runs one evaluation pass (server-side, bounded: accounts with their
 * balances, the month's budgets and transactions, the connections, the due cashflows),
 * then shows the open episodes, the history and the rules. Alerts are observations:
 * nothing here ever writes to the ledger, and dismissing one only silences a warning
 * until the condition resolves and triggers again.
 */
export default async function AlertsPage() {
  const user = await requireUser();

  const now = new Date();
  await refreshAlerts(user.workspace.id, { now });

  const [allAlerts, ruleRows] = await Promise.all([listAlerts(user.workspace.id), listAlertRules(user.workspace.id)]);
  // An inactive module's alerts stay stored, untouched, and come back with the module.
  const alerts = allAlerts.filter((alert) => isAlertVisible(alert.kind, user.workspace.modules));

  const active = alerts.filter((alert) => alert.status === "ACTIVE");
  const history = alerts.filter((alert) => alert.status !== "ACTIVE");
  const rulesFormValues = toAlertRulesFormValues(resolveAlertRules(ruleRows));

  return (
    <>
      <PageHeader
        title="Alertes"
        description="Règles déterministes sur vos propres données : aucun contrôle statistique, aucune écriture automatique dans les opérations. Une alerte écartée se tait tant que la situation dure, puis revient si elle se reproduit après résolution."
        actions={
          <>
            <RefreshAlertsButton />
            <a
              href="/api/export/alerts"
              download
              className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
            >
              Exporter en CSV
            </a>
          </>
        }
      />

      <section aria-labelledby="alertes-actives" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2
            id="alertes-actives"
            className="text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400"
          >
            Alertes actives — {active.length}
          </h2>
          <span className="text-xs text-zinc-500 dark:text-zinc-400">
            Vérifié le {formatInstant(now)}
          </span>
        </div>

        {active.length === 0 ? (
          <EmptyState
            title="Aucune alerte active"
            description="Les règles n'ont rien trouvé à signaler sur les données actuelles. Ce n'est pas une garantie de fraîcheur : la vérification a lieu à chaque ouverture de cette page et du tableau de bord."
          />
        ) : (
          <div className="flex flex-col gap-2">
            {active.map((alert) => (
              <AlertCard key={alert.id} alert={alert} />
            ))}
          </div>
        )}
      </section>

      {history.length > 0 ? (
        <details className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <summary className="cursor-pointer text-sm font-medium">
            Historique — {history.length} alerte{history.length > 1 ? "s" : ""} écartée
            {history.length > 1 ? "s" : ""} ou résolue{history.length > 1 ? "s" : ""}
          </summary>
          <ul className="mt-3 flex flex-col gap-2">
            {history.map((alert) => {
              const described = describeAlert({ kind: alert.kind, inputs: alert.inputs });

              return (
                <li
                  key={alert.id}
                  className="flex flex-col gap-1 border-t border-zinc-100 pt-2 text-sm first:border-t-0 first:pt-0 dark:border-zinc-800"
                >
                  <span className="flex flex-wrap items-center gap-2">
                    <Badge tone={STATUS_TONES[alert.status]}>
                      {ALERT_STATUS_LABELS[alert.status]}
                    </Badge>
                    <span className="font-medium">{described.title}</span>
                    <span className="text-xs text-zinc-500 dark:text-zinc-400">
                      {alert.dismissedAt ? `Écartée le ${formatInstant(alert.dismissedAt)} · ` : ""}
                      {alert.resolvedAt ? `Résolue le ${formatInstant(alert.resolvedAt)}` : ""}
                    </span>
                  </span>
                  <span className="text-zinc-600 dark:text-zinc-400">{described.reason}</span>
                </li>
              );
            })}
          </ul>
        </details>
      ) : null}

      <Card
        title="Règles de surveillance"
        description="Ces règles sont déterministes : un seuil, une comparaison, une explication. Désactiver une règle clôt ses alertes ouvertes ; la réactiver les rouvre en épisodes neufs. Un champ vide reprend la valeur par défaut (indiquée sous le champ)."
      >
        <RulesForm defaults={rulesFormValues} />
      </Card>
    </>
  );
}

/** One open episode: what was found, since when, and the way to silence it. */
function AlertCard({ alert }: { alert: AlertRecord }) {
  const described = describeAlert({ kind: alert.kind, inputs: alert.inputs });

  return (
    <article className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={described.tone === "negative" ? "negative" : "warning"}>
              {described.title}
            </Badge>
            <span className="text-xs text-zinc-500 dark:text-zinc-400">
              Déclenchée le {formatInstant(alert.triggeredAt)} · vue pour la dernière fois le{" "}
              {formatInstant(alert.lastSeenAt)}
            </span>
          </div>
          <p className="text-sm">{described.reason}</p>
        </div>

        <DismissAlertButton alertId={alert.id} />
      </div>
    </article>
  );
}
