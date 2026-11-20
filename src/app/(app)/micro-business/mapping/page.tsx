import { Badge, Card, EmptyState, Notice, PageHeader, TableShell, tdClass, thClass } from "@/components/ui";
import { ModuleDisabled } from "@/components/module-disabled";
import { requireUser } from "@/lib/auth/guard";
import { hasModule } from "@/modules/catalog/catalog";
import { canManageBusinessRecords } from "@/modules/identity/workspace";
import { MAPPING_SELECTOR_LABELS, MAPPING_SELECTORS } from "@/modules/micro-business/mapping";
import {
  listKnownRepositories,
  listProjectMappings,
  readMappingReviewQueue,
} from "@/modules/micro-business/mapping.repository";
import { listProjects } from "@/modules/micro-business/repository";
import { MicroBusinessTabs } from "../micro-business-tabs";
import { DeleteMappingButton } from "./delete-mapping-button";
import { MappingForm } from "./mapping-form";

export const dynamic = "force-dynamic";

/**
 * « Dépôts » — repository-to-project mappings and the review queue (M14-01).
 *
 * The queue lists the open issues and pull requests no rule attributes to exactly one
 * project: they are never attributed silently. It needs the development module, whose
 * synchronised snapshots it reads.
 */
export default async function MappingPage() {
  const user = await requireUser();

  if (!hasModule(user.workspace, "micro-business")) {
    return <ModuleDisabled moduleKey="micro-business" workspace={user.workspace} />;
  }

  const canManage = canManageBusinessRecords(user.workspace.role);
  const withActivity = hasModule(user.workspace, "development");
  const [mappings, projects, repositories, queue] = await Promise.all([
    listProjectMappings(user.workspace.id),
    listProjects(user.workspace.id),
    withActivity ? listKnownRepositories(user.workspace.id) : Promise.resolve([]),
    withActivity ? readMappingReviewQueue(user.workspace.id) : Promise.resolve(null),
  ]);
  const activeProjects = projects.filter((project) => !project.archived).map(({ id, name }) => ({ id, name }));
  const names = new Map(projects.map((project) => [project.id, project.name]));

  return (
    <>
      <PageHeader
        title="Dépôts"
        description="Relier dépôts, étiquettes, jalons, branches et dossiers aux projets. Une ambiguïté part en revue, jamais au hasard."
      />
      <MicroBusinessTabs current="/micro-business/mapping" />

      <Notice tone="info">
        Ordre de priorité : {MAPPING_SELECTORS.map((selector) => MAPPING_SELECTOR_LABELS[selector]).join(" → ")}. Le
        premier niveau qui trouve une règle décide ; deux projets au même niveau rendent l&apos;élément ambigu.
      </Notice>

      {canManage && activeProjects.length > 0 ? (
        <Card title="Nouvelle règle">
          <MappingForm projects={activeProjects} repositories={repositories} />
        </Card>
      ) : null}

      <Card title="Règles">
        {mappings.length === 0 ? (
          <EmptyState title="Aucune règle" description="Sans règle, toute l'activité reste non attribuée et part en revue." />
        ) : (
          <TableShell caption="Règles dépôt → projet">
            <thead>
              <tr>
                <th scope="col" className={thClass}>Dépôt</th>
                <th scope="col" className={thClass}>Sélecteur</th>
                <th scope="col" className={thClass}>Valeur</th>
                <th scope="col" className={thClass}>Projet</th>
                {canManage ? <th scope="col" className={thClass}>Actions</th> : null}
              </tr>
            </thead>
            <tbody>
              {mappings.map((mapping) => (
                <tr key={mapping.id}>
                  <td className={tdClass}>{mapping.repository}</td>
                  <td className={tdClass}>{MAPPING_SELECTOR_LABELS[mapping.selector]}</td>
                  <td className={tdClass}>{mapping.value || "—"}</td>
                  <td className={tdClass}>{mapping.projectName}</td>
                  {canManage ? (
                    <td className={tdClass}>
                      <DeleteMappingButton
                        mappingId={mapping.id}
                        label={`${mapping.repository} · ${MAPPING_SELECTOR_LABELS[mapping.selector]}${mapping.value ? ` « ${mapping.value} »` : ""}`}
                      />
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </TableShell>
        )}
      </Card>

      <Card
        title="File de revue"
        description={queue ? `${queue.items.length} à revoir · ${queue.resolved} attribué(s). Issues et pull requests ouvertes.` : undefined}
      >
        {queue === null ? (
          <EmptyState title="Module Développement inactif" description="La file de revue lit les issues et pull requests synchronisées." />
        ) : queue.items.length === 0 ? (
          <EmptyState title="Rien à revoir" description="Chaque élément ouvert est attribué à un seul projet." />
        ) : (
          <>
            {queue.truncated ? (
              <Notice tone="warning">Seuls les éléments les plus récemment actifs sont lus : la file peut être incomplète.</Notice>
            ) : null}
            <TableShell caption="Activité à attribuer">
              <thead>
                <tr>
                  <th scope="col" className={thClass}>Élément</th>
                  <th scope="col" className={thClass}>État</th>
                  <th scope="col" className={thClass}>Projets possibles</th>
                </tr>
              </thead>
              <tbody>
                {queue.items.map((item) => (
                  <tr key={`${item.kind}-${item.repository}-${item.number}`}>
                    <td className={tdClass}>
                      <a href={item.url} className="underline" rel="noreferrer" target="_blank">
                        {item.repository} #{item.number}
                      </a>
                      <span className="block text-xs text-zinc-500 dark:text-zinc-400">
                        {item.kind === "PULL_REQUEST" ? "PR · " : ""}
                        {item.title}
                      </span>
                    </td>
                    <td className={tdClass}>
                      {item.resolution.status === "ambiguous" ? (
                        <Badge tone="warning">Ambigu ({MAPPING_SELECTOR_LABELS[item.resolution.selector]})</Badge>
                      ) : (
                        <Badge>Non attribué</Badge>
                      )}
                    </td>
                    <td className={`${tdClass} text-xs`}>
                      {item.resolution.status === "ambiguous"
                        ? item.resolution.candidates
                            .map((candidate) => `${names.get(candidate.projectId) ?? candidate.projectId} (« ${candidate.value} »)`)
                            .join(" · ")
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </TableShell>
          </>
        )}
      </Card>
    </>
  );
}
