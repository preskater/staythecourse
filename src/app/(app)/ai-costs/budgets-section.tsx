import Decimal from "decimal.js";
import { Badge, Card, EmptyState, Notice, TableShell, tdClass, thClass } from "@/components/ui";
import { publicEnv } from "@/lib/env";
import { resolveAlertRules } from "@/modules/alerts/domain";
import { listAlertRules } from "@/modules/alerts/repository";
import { toAiBudgetRows, type AiBudgetRowDto } from "@/modules/ai-costs/budgets";
import { listAiBudgets, readAiBudgetSpend } from "@/modules/ai-costs/repository";
import { AiBudgetForm } from "./ai-budget-form";
import { DeleteAiBudgetButton } from "./delete-ai-budget-button";

const STATES: Record<AiBudgetRowDto["state"], { label: string; tone: "neutral" | "positive" | "warning" | "negative" }> = {
  "no-data": { label: "Aucune dépense", tone: "neutral" },
  ok: { label: "Sous le seuil", tone: "positive" },
  threshold: { label: "Seuil atteint", tone: "warning" },
  overrun: { label: "Dépassé", tone: "negative" },
};

/**
 * « Budgets » tab of the AI costs page (M12-03): monthly caps per ledger dimension and
 * their spend this cycle. Alerts themselves live on the Alertes page, where the
 * thresholds are configured; this tab only defines what they watch.
 */
export async function BudgetsSection({
  workspaceId,
  canWrite,
  cycle,
}: {
  workspaceId: string;
  canWrite: boolean;
  cycle: { start: Date; end: Date };
}) {
  const [budgets, ruleRows] = await Promise.all([listAiBudgets(workspaceId), listAlertRules(workspaceId)]);
  const spends = budgets.length > 0 ? await readAiBudgetSpend(workspaceId, budgets, cycle.start, cycle.end) : [];
  const threshold = resolveAlertRules(ruleRows).find((rule) => rule.kind === "AI_BUDGET_THRESHOLD")!;
  const rows = toAiBudgetRows(budgets, spends, threshold.thresholdPercent ?? new Decimal(0));

  return (
    <>
      <Notice tone="info">
        Un budget IA ne coupe aucune dépense : il déclenche une alerte préventive à{" "}
        {threshold.thresholdPercent?.toString() ?? "0"} % puis une alerte de dépassement (seuils
        réglables sur la page Alertes). La dépense est celle de la vue d&apos;ensemble : entrées
        dont la période commence dans le mois civil, remboursements déduits, dans la devise du
        budget uniquement.
      </Notice>

      {canWrite ? (
        <Card
          title="Nouveau budget IA"
          description="Un même périmètre et une même devise n'ont qu'un budget : en enregistrer un second remplace le montant du premier."
        >
          <AiBudgetForm defaultCurrency={publicEnv.NEXT_PUBLIC_DEFAULT_CURRENCY} />
        </Card>
      ) : null}

      <Card title="Budgets IA du mois">
        {rows.length === 0 ? (
          <EmptyState
            title="Aucun budget IA"
            description="Définissez un plafond mensuel pour tout l'espace, un fournisseur, un projet, un client, un développeur ou un agent."
          />
        ) : (
          <TableShell caption="Budgets IA et dépense du mois">
            <thead>
              <tr>
                <th scope="col" className={thClass}>
                  Périmètre
                </th>
                <th scope="col" className={`${thClass} text-right`}>
                  Budget
                </th>
                <th scope="col" className={`${thClass} text-right`}>
                  Dépensé
                </th>
                <th scope="col" className={`${thClass} text-right`}>
                  Part
                </th>
                <th scope="col" className={thClass}>
                  État
                </th>
                {canWrite ? (
                  <th scope="col" className={thClass}>
                    Actions
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className={tdClass}>{row.scope}</td>
                  <td className={`${tdClass} text-right tabular-nums`}>{row.cap}</td>
                  <td className={`${tdClass} text-right tabular-nums`}>{row.spent ?? "—"}</td>
                  <td className={`${tdClass} text-right tabular-nums`}>{row.percent ?? "—"}</td>
                  <td className={tdClass}>
                    <Badge tone={STATES[row.state].tone}>{STATES[row.state].label}</Badge>
                  </td>
                  {canWrite ? (
                    <td className={tdClass}>
                      <DeleteAiBudgetButton budgetId={row.id} label={row.scope} />
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </TableShell>
        )}
      </Card>
    </>
  );
}
