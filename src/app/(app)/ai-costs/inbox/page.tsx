import Link from "next/link";
import { Card, EmptyState, Notice, PageHeader, StatCard } from "@/components/ui";
import { ModuleDisabled } from "@/components/module-disabled";
import { requireUser } from "@/lib/auth/guard";
import { toDateOnlyString } from "@/lib/dates";
import { formatMoney } from "@/lib/money";
import {
  describeDimensions,
  inboxEntryLabel,
  inboxEntryState,
  inboxView,
} from "@/modules/ai-costs/inbox";
import { listAllocationPolicies } from "@/modules/ai-costs/policy.repository";
import {
  listInboxEntries,
  summarizeUnallocatedCosts,
  type InboxEntry,
  type UnallocatedSummary,
} from "@/modules/ai-costs/repository";
import type { CostSourceReference } from "@/modules/ai-costs/source";
import { hasModule } from "@/modules/catalog/catalog";
import { canManageBusinessRecords } from "@/modules/identity/workspace";
import { listProjects } from "@/modules/micro-business/repository";
import { InboxTable, type InboxPolicyOption, type InboxRow } from "./inbox-table";

export const dynamic = "force-dynamic";

const MEASURE_LABELS = {
  EQUAL_SEAT: "Sièges",
  USAGE_WEIGHTED: "Usage",
  MANUAL: "Montant",
} as const;

function sourceLabel(source: CostSourceReference): string {
  switch (source.kind) {
    case "provider":
      return `Fournisseur ${source.provider}`;
    case "import":
      return `Import CSV, ligne ${source.rowNumber}`;
    case "manual":
      return "Saisie manuelle";
  }
}

/**
 * Unallocated-cost inbox (`/ai-costs/inbox`, M9-06).
 *
 * Server-rendered: entries, totals and policies are read here; the table only sends
 * identifiers back to the Server Actions. Totals come from a database aggregate, not
 * from the bounded list, so they stay true when the list is cut.
 */
export default async function CostInboxPage() {
  const user = await requireUser();

  if (!hasModule(user.workspace, "ai-costs")) {
    return <ModuleDisabled moduleKey="ai-costs" workspace={user.workspace} />;
  }

  const workspaceId = user.workspace.id;
  const canManage = canManageBusinessRecords(user.workspace.role);
  let loaded: { list: { entries: InboxEntry[]; truncated: boolean }; summary: UnallocatedSummary[] } | null = null;
  let policies: InboxPolicyOption[] = [];
  let projectNames = new Map<string, string>();

  try {
    const [list, summary, policyRows, projects] = await Promise.all([
      listInboxEntries(workspaceId),
      summarizeUnallocatedCosts(workspaceId),
      canManage ? listAllocationPolicies(workspaceId) : Promise.resolve([]),
      hasModule(user.workspace, "micro-business") ? listProjects(workspaceId) : Promise.resolve([]),
    ]);
    loaded = { list, summary };
    projectNames = new Map(projects.map((project) => [project.id, project.name]));
    policies = policyRows.map((policy) => ({
      id: policy.id,
      name: policy.name,
      version: policy.latestVersion.version,
      measureLabel: policy.kind in MEASURE_LABELS ? MEASURE_LABELS[policy.kind as keyof typeof MEASURE_LABELS] : null,
      targets: policy.latestVersion.targets.map((target) =>
        `${describeDimensions(target.dimensions, projectNames)}${target.percent ? ` (${target.percent} %)` : ""}`,
      ),
    }));
  } catch (error) {
    console.error(`[costInbox] ${error instanceof Error ? error.name : typeof error}`);
  }

  const view = inboxView(
    loaded
      ? {
          ok: true,
          entryCount: loaded.list.entries.length,
          costCount: loaded.summary.reduce((sum, row) => sum + row.entryCount, 0),
        }
      : { ok: false },
  );

  const rows: InboxRow[] =
    loaded?.list.entries.map(({ entry, totals }) => ({
      id: entry.id,
      period:
        entry.periodStart === entry.periodEnd
          ? entry.periodStart
          : `${entry.periodStart} → ${entry.periodEnd}`,
      label: inboxEntryLabel(entry.notes),
      source: sourceLabel(entry.source),
      known: describeDimensions(entry.dimensions, projectNames),
      total: formatMoney(totals.total),
      allocated: formatMoney(totals.allocated),
      unallocated: formatMoney(totals.unallocated),
      state: inboxEntryState(totals),
    })) ?? [];

  return (
    <>
      <PageHeader
        title="Coûts à répartir"
        description="Coûts encore en brouillon : non répartis, partiellement répartis, ou répartis en attente de validation. Rien n'est validé automatiquement et aucun projet par défaut n'est appliqué."
        actions={
          <Link
            href="/ai-costs/import"
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            Importer un CSV
          </Link>
        }
      />

      {view.kind === "error" ? (
        <Notice tone="error">
          Lecture des coûts impossible pour le moment. Ce n&apos;est pas une boîte vide : réessayez dans un
          instant.
        </Notice>
      ) : null}

      {loaded && loaded.summary.length > 0 ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {loaded.summary.map((summary) => (
            <StatCard
              key={summary.currency}
              label={`Pas encore réparti (${summary.currency})`}
              value={formatMoney({ amount: summary.unallocated, currency: summary.currency })}
              tone={summary.unallocated.isZero() ? "positive" : "negative"}
              hint={`Total ${formatMoney({ amount: summary.total, currency: summary.currency })} = réparti ${formatMoney({ amount: summary.allocated, currency: summary.currency })} + non réparti. Coûts validés inclus.`}
            />
          ))}
        </div>
      ) : null}

      {view.kind === "no-costs" ? (
        <EmptyState
          title="Aucun coût enregistré"
          description="La boîte se remplit avec les coûts importés ou saisis. Aucun total n'est affiché pour ne pas laisser croire à des coûts nuls."
        />
      ) : null}

      {view.kind === "nothing-to-review" ? (
        <EmptyState
          title="Rien à revoir"
          description="Tous les coûts sont validés. Un éventuel reste non réparti sur un coût validé figure dans le total ci-dessus."
        />
      ) : null}

      {view.kind === "list" && loaded ? (
        <Card
          title={`${rows.length} coût${rows.length > 1 ? "s" : ""} en brouillon`}
          description="Sélectionnez des coûts, prévisualisez une politique de répartition, appliquez-la, puis validez. Chaque action groupée est tracée dans le journal d'audit."
        >
          {loaded.list.truncated ? (
            <Notice tone="warning">
              Seuls les {rows.length} coûts les plus récents sont affichés. Les totaux ci-dessus couvrent tous les coûts.
            </Notice>
          ) : null}
          {!canManage ? (
            <Notice tone="info">
              Lecture seule : seuls le propriétaire et les administrateurs peuvent répartir ou valider.
            </Notice>
          ) : null}
          {canManage && policies.length === 0 ? (
            <Notice tone="info">
              Aucune politique de répartition active : créez-en une pour pouvoir répartir depuis cette page.
            </Notice>
          ) : null}
          <InboxTable rows={rows} policies={policies} canManage={canManage} />
        </Card>
      ) : null}

      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        Données lues le {toDateOnlyString(new Date())}. Les montants ne sont jamais convertis entre devises.
      </p>
    </>
  );
}
