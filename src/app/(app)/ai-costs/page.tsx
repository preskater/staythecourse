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
import { ModuleDisabled } from "@/components/module-disabled";
import { requireUser } from "@/lib/auth/guard";
import { todayDateOnly } from "@/lib/dates";
import { publicEnv } from "@/lib/env";
import type { SearchParamsInput } from "@/lib/search-params";
import { hasModule } from "@/modules/catalog/catalog";
import {
  buildAiCostOverview,
  currentBillingCycle,
  KPI_STATE_LABELS,
  type KpiState,
  type OverviewLedger,
} from "@/modules/ai-costs/overview";
import { parseExplorerFilters } from "@/modules/ai-costs/explorer";
import { listExplorerOptions, readAiCostOverviewLedger } from "@/modules/ai-costs/repository";
import { AiCostsTabs, resolveAiCostsTab } from "./ai-costs-tabs";
import { ExplorerSection } from "./explorer-section";

export const dynamic = "force-dynamic";

const STATE_TONES: Record<KpiState, "neutral" | "positive" | "negative" | "warning"> = {
  ok: "positive",
  "no-data": "neutral",
  "not-connected": "warning",
  error: "negative",
};

function StateBadge({ state }: { state: KpiState }) {
  return <Badge tone={STATE_TONES[state]}>{KPI_STATE_LABELS[state]}</Badge>;
}

/**
 * « Coûts IA » — read-only overview of the current billing cycle (M12-01) and the
 * multidimensional explorer (M12-02), one `?tab=` each.
 *
 * Every member of the workspace reads it; nothing here writes. A KPI without a data
 * source shows its state and its definition, never a zero.
 */
export default async function AiCostsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParamsInput>;
}) {
  const params = await searchParams;
  const user = await requireUser();

  if (!hasModule(user.workspace, "ai-costs")) {
    return <ModuleDisabled moduleKey="ai-costs" workspace={user.workspace} />;
  }

  const timeZone = publicEnv.NEXT_PUBLIC_DEFAULT_TIME_ZONE;
  const cycle = currentBillingCycle(todayDateOnly(timeZone));
  const tab = resolveAiCostsTab(params.tab);

  if (tab === "explorer") {
    const options = await listExplorerOptions(user.workspace.id);

    return (
      <>
        <PageHeader
          title="Coûts IA"
          description="Filtrez les coûts par dimension et période, puis descendez jusqu'aux entrées sources."
        />
        <AiCostsTabs current="explorer" />
        <ExplorerSection
          workspaceId={user.workspace.id}
          filters={parseExplorerFilters(params, options, cycle)}
          options={options}
          timeZone={timeZone}
        />
      </>
    );
  }

  let ledger: OverviewLedger;
  try {
    ledger = {
      state: "ok",
      ...(await readAiCostOverviewLedger(user.workspace.id, cycle.start, cycle.end)),
    };
  } catch (error) {
    // Name only: a database error message can quote amounts or identifiers.
    console.error(`[ai-costs] ${error instanceof Error ? error.name : typeof error}`);
    ledger = { state: "error" };
  }

  const overview = buildAiCostOverview(ledger, cycle, timeZone);

  return (
    <>
      <PageHeader
        title="Coûts IA"
        description={`Cycle : ${overview.cycleLabel}.`}
        actions={
          <div className="flex gap-4">
            <Link href="/ai-costs/inbox" className="text-sm underline underline-offset-2">
              Coûts non alloués
            </Link>
            <Link href="/ai-costs/connections" className="text-sm underline underline-offset-2">
              Clés des fournisseurs
            </Link>
          </div>
        }
      />

      <AiCostsTabs current="overview" />

      {ledger.state === "error" ? (
        <Notice tone="error">
          Registre des coûts illisible : indicateurs en erreur.
        </Notice>
      ) : null}

      <Card title="Indicateurs du cycle">
        <TableShell caption="Indicateurs des coûts IA du cycle en cours">
          <thead>
            <tr>
              <th scope="col" className={thClass}>
                Indicateur
              </th>
              <th scope="col" className={thClass}>
                Valeur
              </th>
              <th scope="col" className={thClass}>
                Définition
              </th>
            </tr>
          </thead>
          <tbody>
            {overview.kpis.map((kpi) => (
              <tr key={kpi.key}>
                <th scope="row" className={`${tdClass} text-left font-medium`}>
                  {kpi.label}
                </th>
                <td className={tdClass}>
                  {kpi.value !== null ? (
                    <span className="font-semibold tabular-nums">{kpi.value}</span>
                  ) : (
                    <StateBadge state={kpi.state} />
                  )}
                  {kpi.detail ? (
                    <span className="block text-xs text-zinc-500 dark:text-zinc-400">
                      {kpi.detail}
                    </span>
                  ) : null}
                </td>
                <td className={`${tdClass} text-xs text-zinc-600 dark:text-zinc-400`}>
                  <span className="block">{kpi.formula}</span>
                  <span className="block text-zinc-500 dark:text-zinc-500">
                    {kpi.period} · {kpi.sources}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </TableShell>
      </Card>

      <Card
        title="Dépense par devise et fiabilité"
        description="Montants non convertis."
      >
        {overview.spendRows.length === 0 ? (
          <EmptyState
            title={ledger.state === "error" ? "Données indisponibles" : "Aucune dépense sur ce cycle"}
            description={
              ledger.state === "error"
                ? "Registre illisible."
                : "Aucune entrée ce mois-ci."
            }
          />
        ) : (
          <TableShell caption="Dépense du cycle par devise et fiabilité">
            <thead>
              <tr>
                <th scope="col" className={thClass}>
                  Devise
                </th>
                <th scope="col" className={thClass}>
                  Fiabilité
                </th>
                <th scope="col" className={`${thClass} text-right`}>
                  Montant
                </th>
                <th scope="col" className={`${thClass} text-right`}>
                  Entrées
                </th>
              </tr>
            </thead>
            <tbody>
              {overview.spendRows.map((row) => (
                <tr key={`${row.currency}-${row.actuality}`}>
                  <td className={tdClass}>{row.currency}</td>
                  <td className={tdClass}>{row.actuality}</td>
                  <td className={`${tdClass} text-right tabular-nums`}>{row.amount}</td>
                  <td className={`${tdClass} text-right tabular-nums`}>{row.entryCount}</td>
                </tr>
              ))}
            </tbody>
          </TableShell>
        )}
      </Card>

      <Card
        title="Fraîcheur des sources"
        description="Dernière capture de chaque source."
      >
        <TableShell caption="Fraîcheur des sources de coûts">
          <thead>
            <tr>
              <th scope="col" className={thClass}>
                Source
              </th>
              <th scope="col" className={thClass}>
                État
              </th>
              <th scope="col" className={thClass}>
                Dernière capture
              </th>
            </tr>
          </thead>
          <tbody>
            {overview.freshness.map((row) => (
              <tr key={row.source}>
                <td className={tdClass}>{row.source}</td>
                <td className={tdClass}>
                  <StateBadge state={row.state} />
                  {row.detail ? (
                    <span className="block text-xs text-zinc-500 dark:text-zinc-400">
                      {row.detail}
                    </span>
                  ) : null}
                </td>
                <td className={`${tdClass} tabular-nums`}>{row.lastCapturedAt ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </TableShell>
      </Card>
    </>
  );
}
