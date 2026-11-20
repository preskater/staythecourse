import { Badge, Card, EmptyState, Notice, TableShell, tdClass, thClass } from "@/components/ui";
import {
  COPILOT_ACTIVITY_LABELS,
  COPILOT_ACTIVITY_NOTICE,
  COPILOT_SEAT_STATUS_LABELS,
  copilotSeatStatus,
  type CopilotSeatStatus,
} from "@/modules/ai-costs/copilot";
import { readCopilotOverview, type CopilotDayRow, type CopilotSeatRow } from "@/modules/ai-costs/copilot.repository";

const SEAT_TONES: Record<CopilotSeatStatus, "positive" | "negative" | "warning"> = {
  RECONCILED: "positive",
  MISMATCH: "negative",
  INCOMPLETE: "warning",
};

const figure = (value: number | null) => (value === null ? "Non communiqué" : value.toLocaleString("fr-FR"));

/**
 * « GitHub Copilot » (M11-08): latest seat reading and latest reported day per
 * organization. Read-only, organization totals only — nothing per member, so nothing
 * here can rank people. Cost is not tracked: the API exposes no price.
 */
export async function CopilotSection({ workspaceId }: { workspaceId: string }) {
  let data: { seats: CopilotSeatRow[]; days: CopilotDayRow[] } | null = null;
  try {
    data = await readCopilotOverview(workspaceId);
  } catch (error) {
    // Name only: a database error message can quote identifiers.
    console.error(`[copilot] ${error instanceof Error ? error.name : typeof error}`);
  }

  const organizations = data
    ? [...new Set([...data.seats, ...data.days].map((row) => row.organization))].sort()
    : [];

  return (
    <Card
      title="GitHub Copilot"
      description="Sièges et activité par organisation. Coût non suivi : l'API GitHub ne donne aucun prix ; il passe par la facture GitHub."
    >
      <p className="text-xs text-zinc-500 dark:text-zinc-400">{COPILOT_ACTIVITY_NOTICE}</p>

      {!data ? <Notice tone="error">Données Copilot illisibles pour le moment.</Notice> : null}

      {data && organizations.length === 0 ? (
        <EmptyState
          title="Non connecté"
          description="Aucune donnée Copilot importée. Ce n'est pas une absence d'usage : aucune organisation n'a encore été synchronisée."
        />
      ) : null}

      {data
        ? organizations.map((organization) => {
            const seats = data.seats.find((row) => row.organization === organization);
            const day = data.days.find((row) => row.organization === organization);
            const status = seats ? copilotSeatStatus(seats) : null;

            return (
              <div key={organization} className="flex flex-col gap-2">
                <h3 className="text-sm font-semibold">{organization}</h3>
                <TableShell caption={`Sièges et activité Copilot de ${organization}`}>
                  <tbody>
                    <tr>
                      <th scope="row" className={`${tdClass} text-left font-normal`}>
                        Sièges {seats ? `(relevé du ${seats.day}${seats.planType ? `, offre ${seats.planType}` : ""})` : ""}
                      </th>
                      <td className={`${tdClass} text-right tabular-nums`}>
                        {seats ? (
                          <>
                            {seats.total} dont {seats.activeThisCycle} actifs et {seats.inactiveThisCycle} inactifs sur le cycle
                            {seats.pendingInvitation + seats.pendingCancellation > 0
                              ? ` · ${seats.pendingInvitation} invitation(s), ${seats.pendingCancellation} résiliation(s) en attente`
                              : ""}{" "}
                            <Badge tone={SEAT_TONES[status!]}>{COPILOT_SEAT_STATUS_LABELS[status!]}</Badge>
                          </>
                        ) : (
                          <Badge tone="warning">Non relevés</Badge>
                        )}
                      </td>
                    </tr>
                    {day ? (
                      <>
                        <tr>
                          <th scope="row" className={`${tdClass} text-left font-normal`}>Dernier jour remonté</th>
                          <td className={`${tdClass} text-right tabular-nums`}>{day.day}</td>
                        </tr>
                        {(Object.keys(COPILOT_ACTIVITY_LABELS) as (keyof typeof COPILOT_ACTIVITY_LABELS)[]).map((key) => (
                          <tr key={key}>
                            <th scope="row" className={`${tdClass} text-left font-normal`}>{COPILOT_ACTIVITY_LABELS[key]}</th>
                            <td className={`${tdClass} text-right tabular-nums`}>{figure(day[key])}</td>
                          </tr>
                        ))}
                        <tr>
                          <th scope="row" className={`${tdClass} text-left font-normal`}>Agents tiers utilisés</th>
                          <td className={`${tdClass} text-right`}>
                            {day.thirdPartyAgents.length === 0
                              ? "Aucun ce jour"
                              : day.thirdPartyAgents
                                  .map((agent) => `${agent.agentName} (${figure(agent.interactions)} interaction(s))`)
                                  .join(" · ")}
                          </td>
                        </tr>
                      </>
                    ) : (
                      <tr>
                        <th scope="row" className={`${tdClass} text-left font-normal`}>Activité</th>
                        <td className={`${tdClass} text-right`}>
                          <Badge tone="warning">Aucun rapport importé</Badge>
                        </td>
                      </tr>
                    )}
                  </tbody>
                </TableShell>
              </div>
            );
          })
        : null}

      {data && organizations.length > 0 ? (
        <TableShell caption="Définition des indicateurs Copilot">
          <thead>
            <tr>
              <th scope="col" className={thClass}>Source</th>
              <th scope="col" className={thClass}>Définition</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className={tdClass}>Sièges</td>
              <td className={`${tdClass} text-xs`}>
                Répartition GitHub du jour, comparée au nombre de sièges de la liste GitHub ; aucun nom n&apos;est conservé.
              </td>
            </tr>
            <tr>
              <td className={tdClass}>Activité</td>
              <td className={`${tdClass} text-xs`}>
                Rapport quotidien d&apos;organisation, publié environ deux jours UTC après la journée ; un jour sans rapport
                reste absent, jamais compté à zéro.
              </td>
            </tr>
          </tbody>
        </TableShell>
      ) : null}
    </Card>
  );
}
