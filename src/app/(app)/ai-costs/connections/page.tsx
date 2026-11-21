import { Badge, Card, EmptyState, Notice, PageHeader, TableShell, tdClass, thClass } from "@/components/ui";
import { ModuleDisabled } from "@/components/module-disabled";
import { requireUser } from "@/lib/auth/guard";
import { formatInstant } from "@/lib/dates";
import {
  ADAPTERS,
  AI_CONNECTION_PROVIDERS,
  AI_PROVIDER_LABELS,
  describeValidationError,
  type AiConnectionSummary,
} from "@/modules/ai-costs/connections";
import { listAiConnections } from "@/modules/ai-costs/connections.repository";
import { hasModule } from "@/modules/catalog/catalog";
import { canManageBusinessRecords } from "@/modules/identity/workspace";
import { connectAiProviderAction, revalidateAiConnectionAction, revokeAiConnectionAction } from "./actions";

export const dynamic = "force-dynamic";

/**
 * AI provider credentials (`/ai-costs/connections`, M11-05).
 *
 * The page receives summaries only: a stored secret is never sent back, not even
 * masked. A secret is typed once, tested with the provider, then encrypted.
 */

const FEEDBACK: Record<string, { tone: "info" | "warning" | "error"; text: string }> = {
  connected: { tone: "info", text: "Clé vérifiée auprès du fournisseur et enregistrée chiffrée." },
  rotated: { tone: "info", text: "Clé remplacée : l'ancienne a été écrasée. Révoquez-la aussi chez le fournisseur." },
  valid: { tone: "info", text: "Clé testée : le fournisseur l'accepte." },
  revoked: {
    tone: "warning",
    text: "Clé détruite ici : plus aucun import ne peut l'utiliser. Révoquez-la aussi dans la console du fournisseur.",
  },
  invalid: { tone: "error", text: "Formulaire invalide : choisissez un fournisseur et collez la clé complète." },
  unconfirmed: { tone: "error", text: "Révocation annulée : cochez la confirmation." },
  not_found: { tone: "error", text: "Connexion introuvable." },
  forbidden: { tone: "error", text: "Seuls le propriétaire et les administrateurs de l'espace gèrent les clés." },
};

const STATUS: Record<AiConnectionSummary["status"], { label: string; tone: "positive" | "negative" | "neutral" }> = {
  VALID: { label: "Valide", tone: "positive" },
  INVALID: { label: "Refusée", tone: "negative" },
  REVOKED: { label: "Révoquée", tone: "neutral" },
};

function feedback(params: Record<string, string | string[] | undefined>) {
  const status = typeof params.status === "string" ? params.status : null;
  const code = typeof params.code === "string" ? params.code : null;
  if (!status) return null;
  // A refused or failed test carries a code: its explanation is more useful than a status.
  if (code && (status === "rejected" || status === "invalid" || status === "unavailable")) {
    const prefix = status === "rejected" ? "Clé non enregistrée. " : "";
    return { tone: status === "unavailable" ? ("warning" as const) : ("error" as const), text: `${prefix}${describeValidationError(code)}` };
  }
  return FEEDBACK[status] ?? null;
}

function Scopes({ connection }: { connection: AiConnectionSummary }) {
  if (connection.grantedScopes !== null) {
    return <>{connection.grantedScopes.length > 0 ? connection.grantedScopes.join(", ") : "Aucune"}</>;
  }
  return (
    <span className="text-zinc-600 dark:text-zinc-400">
      Non communiquées par le fournisseur · utilisées : {ADAPTERS[connection.provider].requiredScopes.join(", ")}
    </span>
  );
}

export default async function AiConnectionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  if (!hasModule(user.workspace, "ai-costs")) {
    return <ModuleDisabled moduleKey="ai-costs" workspace={user.workspace} />;
  }

  const canManage = canManageBusinessRecords(user.workspace.role);
  const [connections, params] = await Promise.all([
    canManage ? listAiConnections(user.workspace.id) : Promise.resolve([]),
    searchParams,
  ]);
  const message = feedback(params);

  return (
    <>
      <PageHeader
        title="Clés des fournisseurs IA"
        description="Clés utilisées pour importer l'usage et les coûts. Une clé est testée auprès du fournisseur avant d'être enregistrée, puis chiffrée (AES-256-GCM) ; elle n'est plus jamais affichée, même partiellement."
      />

      {message && <Notice tone={message.tone}>{message.text}</Notice>}

      {!canManage ? (
        <Notice tone="warning">Seuls le propriétaire et les administrateurs de l&apos;espace gèrent les clés des fournisseurs.</Notice>
      ) : (
        <>
          <Card title="Connexions" description="État du dernier test de chaque clé. Une clé refusée ou révoquée n'est utilisée par aucun import.">
            {connections.length === 0 ? (
              <EmptyState title="Aucune clé enregistrée" description="Ajoutez la clé d'un fournisseur ci-dessous." />
            ) : (
              <TableShell>
                <thead>
                  <tr>
                    <th className={thClass}>Fournisseur</th>
                    <th className={thClass}>État</th>
                    <th className={thClass}>Permissions</th>
                    <th className={thClass}>Dernier test</th>
                    <th className={thClass}>Clé enregistrée le</th>
                    <th className={thClass}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {connections.map((connection) => (
                    <tr key={connection.id}>
                      <td className={tdClass}>
                        <div className="font-medium">{AI_PROVIDER_LABELS[connection.provider].name}</div>
                        {connection.accountLabel && (
                          <div className="text-xs text-zinc-600 dark:text-zinc-400">{connection.accountLabel}</div>
                        )}
                      </td>
                      <td className={tdClass}>
                        <Badge tone={STATUS[connection.status].tone}>{STATUS[connection.status].label}</Badge>
                        {connection.status === "INVALID" && (
                          <div className="mt-1 text-xs">{describeValidationError(connection.lastValidationError)}</div>
                        )}
                      </td>
                      <td className={tdClass}>
                        <Scopes connection={connection} />
                      </td>
                      <td className={tdClass}>{connection.lastValidatedAt ? formatInstant(connection.lastValidatedAt) : "—"}</td>
                      <td className={tdClass}>
                        {connection.revokedAt
                          ? `Révoquée le ${formatInstant(connection.revokedAt)}`
                          : formatInstant(connection.credentialUpdatedAt)}
                      </td>
                      <td className={tdClass}>
                        {connection.status !== "REVOKED" && (
                          <div className="flex flex-col gap-2">
                            <form action={revalidateAiConnectionAction}>
                              <input type="hidden" name="connectionId" value={connection.id} />
                              <button type="submit" className="text-sm underline underline-offset-2">
                                Tester la clé
                              </button>
                            </form>
                            <form action={revokeAiConnectionAction} className="flex flex-wrap items-center gap-2">
                              <input type="hidden" name="connectionId" value={connection.id} />
                              <label className="flex items-center gap-1 text-xs">
                                <input type="checkbox" name="confirm" value="yes" required />
                                Je confirme
                              </label>
                              <button type="submit" className="text-sm text-rose-700 underline underline-offset-2 dark:text-rose-300">
                                Révoquer
                              </button>
                            </form>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </TableShell>
            )}
          </Card>

          <Card
            title="Ajouter ou remplacer une clé"
            description="Une clé pour un fournisseur déjà connecté remplace l'ancienne, seulement si la nouvelle est acceptée : sinon l'ancienne reste en place. Révoquez ensuite l'ancienne dans la console du fournisseur."
          >
            <form action={connectAiProviderAction} className="flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1 text-sm">
                <span className="font-medium">Fournisseur</span>
                <select
                  name="provider"
                  required
                  className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-900"
                >
                  {AI_CONNECTION_PROVIDERS.map((provider) => (
                    <option key={provider} value={provider}>
                      {AI_PROVIDER_LABELS[provider].name} — {AI_PROVIDER_LABELS[provider].credential}
                    </option>
                  ))}
                </select>
              </label>

              <label className="flex flex-col gap-1 text-sm">
                <span className="font-medium">Clé</span>
                <input
                  name="secret"
                  type="password"
                  required
                  autoComplete="off"
                  spellCheck={false}
                  className="w-80 max-w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-900"
                />
              </label>

              <button
                type="submit"
                className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
              >
                Tester et enregistrer
              </button>
            </form>
          </Card>
        </>
      )}
    </>
  );
}
