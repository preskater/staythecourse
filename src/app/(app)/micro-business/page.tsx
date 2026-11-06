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
import { hasModule } from "@/modules/catalog/catalog";
import { formatDateOnly } from "@/lib/dates";
import { canManageBusinessRecords } from "@/modules/identity/workspace";
import {
  BILLING_MODEL_LABELS,
  billingBehaviour,
  PROJECT_STATUS_LABELS,
  toClientFormInitialValues,
  toProjectFormInitialValues,
  type ProjectSummary,
} from "@/modules/micro-business/domain";
import { listClients, listProjects } from "@/modules/micro-business/repository";
import { ArchiveToggle } from "./archive-toggle";
import { ClientForm } from "./client-form";
import { ProjectForm, type ClientOption } from "./project-form";

export const dynamic = "force-dynamic";

/** A period reads "—" when a date is missing: an unknown date is not a guessed one. */
function formatPeriod(project: ProjectSummary): string {
  const start = project.startDate ? formatDateOnly(project.startDate) : "—";
  const end = project.endDate ? formatDateOnly(project.endDate) : "—";
  return `${start} → ${end}`;
}

/**
 * « Micro-entreprise » — clients and projects.
 *
 * Both lists include archived records with their state, because archiving is how this
 * module hides a finished client or project without erasing it. Only the workspace's
 * owner and admins write; every member reads.
 */
export default async function MicroBusinessPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const user = await requireUser();

  if (!hasModule(user.workspace, "micro-business")) {
    return <ModuleDisabled moduleKey="micro-business" workspace={user.workspace} />;
  }

  const canManage = canManageBusinessRecords(user.workspace.role);
  const [clients, projects] = await Promise.all([
    listClients(user.workspace.id),
    listProjects(user.workspace.id),
  ]);

  // An edit target is looked up in the workspace-scoped lists already loaded: a foreign
  // or unknown identifier falls back to the creation form without revealing anything.
  const editClientId =
    canManage && typeof params.editClient === "string" ? params.editClient : null;
  const editProjectId =
    canManage && typeof params.editProject === "string" ? params.editProject : null;
  const editingClient = editClientId
    ? (clients.find((client) => client.id === editClientId) ?? null)
    : null;
  const editingProject = editProjectId
    ? (projects.find((project) => project.id === editProjectId) ?? null)
    : null;

  // An archived client stays selectable only while it is the edited project's client:
  // new links never point at an archived record.
  const clientOptions: ClientOption[] = clients
    .filter((client) => !client.archived || client.id === editingProject?.clientId)
    .map((client) => ({ id: client.id, name: client.name, archived: client.archived }));

  const activeClients = clients.filter((client) => !client.archived);
  const activeProjects = projects.filter((project) => !project.archived);
  const runningProjects = activeProjects.filter((project) => project.status === "ACTIVE");
  const billableProjects = activeProjects.filter(
    (project) => billingBehaviour(project.billingModel).billable,
  );

  const editLinkClass =
    "rounded-md border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800";

  return (
    <>
      <PageHeader
        title="Micro-entreprise"
        description="Clients et projets de l'espace. Le modèle de facturation de chaque projet rend explicite ce qui produira un revenu : un projet interne ou non facturable n'en attend aucun. Archiver conserve toutes les données."
      />

      {canManage ? null : (
        <Notice tone="info">
          Seuls le propriétaire et les administrateurs de l&apos;espace peuvent créer ou modifier
          des clients et des projets. Vous pouvez consulter les données existantes.
        </Notice>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard label="Clients actifs" value={String(activeClients.length)} />
        <StatCard label="Projets en cours" value={String(runningProjects.length)} />
        <StatCard
          label="Projets facturables"
          value={String(billableProjects.length)}
          hint="Parmi les projets non archivés."
        />
      </div>

      <Card
        id="client-form"
        title={editingClient ? `Modifier le client « ${editingClient.name} »` : "Nouveau client"}
        description="Le nom est unique dans l'espace. Archiver un client conserve ses projets et son historique."
        actions={
          editingClient ? (
            <Link href="/micro-business" className="text-xs underline">
              Annuler la modification
            </Link>
          ) : null
        }
      >
        <div className="flex flex-col gap-4">
          {canManage ? (
            <ClientForm
              key={editingClient?.id ?? "new"}
              client={editingClient ? toClientFormInitialValues(editingClient) : null}
            />
          ) : null}

          {clients.length === 0 ? (
            <EmptyState
              title="Aucun client enregistré"
              description="Ajoutez un client pour rattacher un projet facturable à son bénéficiaire."
            />
          ) : (
            <TableShell caption="Clients de l'espace">
              <thead>
                <tr>
                  <th scope="col" className={thClass}>
                    Client
                  </th>
                  <th scope="col" className={thClass}>
                    Contact
                  </th>
                  <th scope="col" className={thClass}>
                    E-mail
                  </th>
                  <th scope="col" className={thClass}>
                    Projets
                  </th>
                  <th scope="col" className={thClass}>
                    État
                  </th>
                  {canManage ? (
                    <th scope="col" className={thClass}>
                      Actions
                    </th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {clients.map((client) => (
                  <tr key={client.id}>
                    <td className={tdClass}>
                      <span className="font-medium">{client.name}</span>
                      {client.notes ? (
                        <span className="block max-w-64 truncate text-xs text-zinc-500 dark:text-zinc-400">
                          {client.notes}
                        </span>
                      ) : null}
                    </td>
                    <td className={tdClass}>{client.contactName ?? "—"}</td>
                    <td className={tdClass}>{client.email ?? "—"}</td>
                    <td className={tdClass}>
                      {client.projectCount}
                      <span className="block text-xs text-zinc-500 dark:text-zinc-400">
                        dont {client.activeProjectCount} en cours
                      </span>
                    </td>
                    <td className={tdClass}>
                      <Badge tone={client.archived ? "neutral" : "positive"}>
                        {client.archived ? "Archivé" : "Actif"}
                      </Badge>
                    </td>
                    {canManage ? (
                      <td className={tdClass}>
                        <span className="flex flex-wrap items-start gap-2">
                          <Link
                            href={`/micro-business?editClient=${client.id}#client-form`}
                            className={editLinkClass}
                          >
                            Modifier
                          </Link>
                          <ArchiveToggle
                            kind="client"
                            id={client.id}
                            label={client.name}
                            archived={client.archived}
                          />
                        </span>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </TableShell>
          )}
        </div>
      </Card>

      <Card
        id="project-form"
        title={editingProject ? `Modifier le projet « ${editingProject.name} »` : "Nouveau projet"}
        description="Un modèle facturable exige un client. La devise du projet lui est propre : aucun montant n'est converti entre projets."
        actions={
          editingProject ? (
            <Link href="/micro-business" className="text-xs underline">
              Annuler la modification
            </Link>
          ) : null
        }
      >
        <div className="flex flex-col gap-4">
          {canManage ? (
            <ProjectForm
              key={editingProject?.id ?? "new"}
              clients={clientOptions}
              project={editingProject ? toProjectFormInitialValues(editingProject) : null}
            />
          ) : null}

          {projects.length === 0 ? (
            <EmptyState
              title="Aucun projet enregistré"
              description="Ajoutez un projet pour lui donner un modèle de facturation, un statut et une devise de référence."
            />
          ) : (
            <TableShell caption="Projets de l'espace">
              <thead>
                <tr>
                  <th scope="col" className={thClass}>
                    Projet
                  </th>
                  <th scope="col" className={thClass}>
                    Client
                  </th>
                  <th scope="col" className={thClass}>
                    Facturation
                  </th>
                  <th scope="col" className={thClass}>
                    Statut
                  </th>
                  <th scope="col" className={thClass}>
                    Devise
                  </th>
                  <th scope="col" className={thClass}>
                    Période
                  </th>
                  <th scope="col" className={thClass}>
                    État
                  </th>
                  {canManage ? (
                    <th scope="col" className={thClass}>
                      Actions
                    </th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {projects.map((project) => {
                  const billable = billingBehaviour(project.billingModel).billable;

                  return (
                    <tr key={project.id}>
                      <td className={tdClass}>
                        <span className="font-medium">{project.name}</span>
                        {project.notes ? (
                          <span className="block max-w-64 truncate text-xs text-zinc-500 dark:text-zinc-400">
                            {project.notes}
                          </span>
                        ) : null}
                      </td>
                      <td className={tdClass}>{project.clientName ?? "—"}</td>
                      <td className={tdClass}>
                        {BILLING_MODEL_LABELS[project.billingModel]}
                        <span className="block">
                          <Badge tone={billable ? "positive" : "neutral"}>
                            {billable ? "Facturable" : "Non facturable"}
                          </Badge>
                        </span>
                      </td>
                      <td className={tdClass}>{PROJECT_STATUS_LABELS[project.status]}</td>
                      <td className={tdClass}>{project.currency}</td>
                      <td className={tdClass}>{formatPeriod(project)}</td>
                      <td className={tdClass}>
                        <Badge tone={project.archived ? "neutral" : "positive"}>
                          {project.archived ? "Archivé" : "Actif"}
                        </Badge>
                      </td>
                      {canManage ? (
                        <td className={tdClass}>
                          <span className="flex flex-wrap items-start gap-2">
                            <Link
                              href={`/micro-business?editProject=${project.id}#project-form`}
                              className={editLinkClass}
                            >
                              Modifier
                            </Link>
                            <ArchiveToggle
                              kind="project"
                              id={project.id}
                              label={project.name}
                              archived={project.archived}
                            />
                          </span>
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </TableShell>
          )}
        </div>
      </Card>
    </>
  );
}
