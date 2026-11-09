import Link from "next/link";
import {
  Badge,
  Card,
  EmptyState,
  Notice,
  PageHeader,
  StatCard,
  TableShell,
  tdClass,
  thClass,
} from "@/components/ui";
import { ModuleDisabled } from "@/components/module-disabled";
import { requireUser } from "@/lib/auth/guard";
import { formatInstant } from "@/lib/dates";
import { formatMoney } from "@/lib/money";
import { readSearchParam, type SearchParamsInput } from "@/lib/search-params";
import { hasModule } from "@/modules/catalog/catalog";
import { canManageBusinessRecords } from "@/modules/identity/workspace";
import {
  compareEstimateVersions,
  ESTIMATE_VERSION_KIND_LABELS,
  ESTIMATE_VERSION_STATUS_LABELS,
  estimateTotal,
  type EstimateComparisonLine,
  type EstimateVersionRecord,
  type EstimateVersionStatus,
} from "@/modules/micro-business/estimates";
import { listEstimateVersions, listProjects } from "@/modules/micro-business/repository";
import { ApproveEstimateButton } from "./approve-estimate-button";
import { EstimateForm } from "./estimate-form";

export const dynamic = "force-dynamic";

function statusTone(status: EstimateVersionStatus): "neutral" | "positive" | "warning" {
  if (status === "APPROVED") {
    return "positive";
  }

  return status === "DRAFT" ? "warning" : "neutral";
}

function versionLabel(version: EstimateVersionRecord): string {
  return `${version.projectName} · v${version.versionNumber} · ${ESTIMATE_VERSION_KIND_LABELS[version.kind]} (${ESTIMATE_VERSION_STATUS_LABELS[version.status]})`;
}

function money(line: EstimateComparisonLine, side: "before" | "after", currency: EstimateVersionRecord["currency"]): string {
  const value = line[side];
  return value === null ? "—" : formatMoney({ amount: value, currency });
}

function changesOf(
  lines: readonly EstimateComparisonLine[],
  kind: string,
): { line: EstimateComparisonLine; kind: string }[] {
  return lines.map((line) => ({ line, kind }));
}

/**
 * « Devis » — estimate and scope-change versions.
 *
 * Versions are immutable: the page creates and approves, it never edits. Approving a
 * draft supersedes the project's previous approved version in one transaction. The
 * comparison is recomputed from the stored lines on every request, so it is
 * reproducible months later and never becomes a stale snapshot.
 */
export default async function EstimatesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParamsInput>;
}) {
  const user = await requireUser();

  if (!hasModule(user.workspace, "micro-business")) {
    return <ModuleDisabled moduleKey="micro-business" workspace={user.workspace} />;
  }

  const canManage = canManageBusinessRecords(user.workspace.role);
  const params = await searchParams;
  const [projects, versions] = await Promise.all([
    listProjects(user.workspace.id),
    listEstimateVersions(user.workspace.id),
  ]);

  const projectOptions = projects
    .filter((project) => !project.archived)
    .map((project) => ({
      id: project.id,
      name: project.name,
      currency: project.currency,
    }));

  const fromId = readSearchParam(params, "compareFrom");
  const toId = readSearchParam(params, "compareTo");
  const from = fromId ? (versions.find((version) => version.id === fromId) ?? null) : null;
  const to = toId ? (versions.find((version) => version.id === toId) ?? null) : null;
  const sameProject = from !== null && to !== null && from.projectId === to.projectId;
  const comparison = sameProject ? compareEstimateVersions(from.items, to.items) : null;
  const hasDifferences =
    comparison !== null &&
    comparison.added.length + comparison.removed.length + comparison.changed.length > 0;

  const deltaTone = !comparison
    ? "neutral"
    : comparison.delta.greaterThan(0)
      ? "positive"
      : comparison.delta.lessThan(0)
        ? "negative"
        : "neutral";

  return (
    <>
      <PageHeader
        title="Devis"
        description="Devis initial, révisions et demandes de changement. Une version n'est jamais modifiée : approuver remplace la précédente, et toute comparaison est recalculée à partir des lignes enregistrées. Les montants sont signés et la devise est celle du projet."
        actions={
          <Link href="/micro-business" className="text-xs underline">
            ← Micro-entreprise
          </Link>
        }
      />

      {canManage ? null : (
        <Notice tone="info">
          Seuls le propriétaire et les administrateurs de l&apos;espace peuvent créer ou
          approuver une version de devis. Vous pouvez consulter les versions existantes.
        </Notice>
      )}

      {canManage ? (
        <Card
          title="Nouvelle version"
          description="La première version d'un projet doit être le devis initial. Chaque ligne se saisit au format « Libellé | montant » ; un montant négatif exprime une réduction de périmètre."
        >
          <EstimateForm projects={projectOptions} />
        </Card>
      ) : null}

      <Card
        title="Versions enregistrées"
        description="Une version approuvée ne peut plus être modifiée ni approuvée à nouveau ; une version plus récente la remplace. Une version en brouillon peut être approuvée."
      >
        {versions.length === 0 ? (
          <EmptyState
            title="Aucune version de devis"
            description="Créez le devis initial d'un projet pour poser le point de comparaison des révisions."
          />
        ) : (
          <TableShell caption="Versions de devis">
            <thead>
              <tr>
                <th scope="col" className={thClass}>
                  Projet
                </th>
                <th scope="col" className={thClass}>
                  Version
                </th>
                <th scope="col" className={thClass}>
                  Type
                </th>
                <th scope="col" className={thClass}>
                  Statut
                </th>
                <th scope="col" className={thClass}>
                  Total
                </th>
                <th scope="col" className={thClass}>
                  Approuvée le
                </th>
                {canManage ? (
                  <th scope="col" className={thClass}>
                    Actions
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {versions.map((version) => (
                <tr key={version.id}>
                  <td className={tdClass}>{version.projectName}</td>
                  <td className={tdClass}>
                    v{version.versionNumber}
                    {version.assumptions ? (
                      <span className="block max-w-56 truncate text-xs text-zinc-500 dark:text-zinc-400">
                        {version.assumptions}
                      </span>
                    ) : null}
                  </td>
                  <td className={tdClass}>{ESTIMATE_VERSION_KIND_LABELS[version.kind]}</td>
                  <td className={tdClass}>
                    <Badge tone={statusTone(version.status)}>
                      {ESTIMATE_VERSION_STATUS_LABELS[version.status]}
                    </Badge>
                  </td>
                  <td className={tdClass}>
                    {formatMoney({
                      amount: estimateTotal(version.items),
                      currency: version.currency,
                    })}
                  </td>
                  <td className={tdClass}>
                    {version.approvedAt ? formatInstant(version.approvedAt) : "—"}
                  </td>
                  {canManage ? (
                    <td className={tdClass}>
                      {version.status === "DRAFT" ? (
                        <ApproveEstimateButton
                          versionId={version.id}
                          versionNumber={version.versionNumber}
                        />
                      ) : (
                        <span className="text-xs text-zinc-500 dark:text-zinc-400">
                          {version.status === "APPROVED" ? "Version courante" : "Remplacée"}
                        </span>
                      )}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </TableShell>
        )}
      </Card>

      <Card
        title="Comparer deux versions"
        description="La comparaison est calculée à partir des lignes enregistrées, par libellé. Elle est reproductible et ne repose sur aucun instantané sauvegardé."
      >
        <div className="flex flex-col gap-4">
          <form method="get" action="/micro-business/estimates" className="grid gap-3 sm:grid-cols-3">
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium">Version de départ</span>
              <select name="compareFrom" defaultValue={fromId ?? ""} className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100">
                <option value="">Choisir…</option>
                {versions.map((version) => (
                  <option key={version.id} value={version.id}>
                    {versionLabel(version)}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium">Version d&apos;arrivée</span>
              <select name="compareTo" defaultValue={toId ?? ""} className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100">
                <option value="">Choisir…</option>
                {versions.map((version) => (
                  <option key={version.id} value={version.id}>
                    {versionLabel(version)}
                  </option>
                ))}
              </select>
            </label>

            <div className="flex items-end">
              <button
                type="submit"
                className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
              >
                Comparer
              </button>
            </div>
          </form>

          {from && to && !sameProject ? (
            <Notice tone="warning">
              Les deux versions choisies appartiennent à des projets différents : une
              comparaison n&apos;aurait pas de sens. Choisissez deux versions du même projet.
            </Notice>
          ) : null}

          {from && !to ? (
            <Notice tone="info">
              Choisissez la version d&apos;arrivée pour afficher les changements depuis «{" "}
              {versionLabel(from)} ».
            </Notice>
          ) : null}

          {comparison && from && to ? (
            <div className="flex flex-col gap-3">
              <div className="grid gap-3 sm:grid-cols-3">
                <StatCard
                  label={`Avant · v${from.versionNumber}`}
                  value={formatMoney({
                    amount: comparison.beforeTotal,
                    currency: from.currency,
                  })}
                />
                <StatCard
                  label={`Après · v${to.versionNumber}`}
                  value={formatMoney({
                    amount: comparison.afterTotal,
                    currency: from.currency,
                  })}
                />
                <StatCard
                  label="Écart"
                  value={formatMoney({
                    amount: comparison.delta,
                    currency: from.currency,
                  })}
                  tone={deltaTone}
                />
              </div>

              {hasDifferences ? (
                <TableShell caption="Changements entre les deux versions">
                  <thead>
                    <tr>
                      <th scope="col" className={thClass}>
                        Changement
                      </th>
                      <th scope="col" className={thClass}>
                        Ligne
                      </th>
                      <th scope="col" className={thClass}>
                        Avant
                      </th>
                      <th scope="col" className={thClass}>
                        Après
                      </th>
                      <th scope="col" className={thClass}>
                        Écart
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {[
                      ...changesOf(comparison.added, "Ajoutée"),
                      ...changesOf(comparison.removed, "Supprimée"),
                      ...changesOf(comparison.changed, "Modifiée"),
                    ].map(({ line, kind }) => (
                      <tr key={`${kind}-${line.label}`}>
                        <td className={tdClass}>{kind}</td>
                        <td className={tdClass}>{line.label}</td>
                        <td className={tdClass}>{money(line, "before", from.currency)}</td>
                        <td className={tdClass}>{money(line, "after", from.currency)}</td>
                        <td className={tdClass}>
                          {formatMoney({ amount: line.delta, currency: from.currency })}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </TableShell>
              ) : (
                <EmptyState
                  title="Aucune différence"
                  description="Les deux versions portent exactement les mêmes lignes et les mêmes montants."
                />
              )}
            </div>
          ) : null}
        </div>
      </Card>
    </>
  );
}
