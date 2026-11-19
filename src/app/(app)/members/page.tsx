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
import { requirePermission } from "@/lib/auth/guard";
import { formatInstant } from "@/lib/dates";
import {
  INVITABLE_ROLES,
  INVITATION_TTL_DAYS,
  invitationStatus,
  type InvitationStatus,
} from "@/modules/identity/invitations";
import {
  canChangeMemberRole,
  canGrantRole,
  canRemoveMember,
} from "@/modules/identity/permissions";
import {
  listWorkspaceInvitations,
  listWorkspaceMembers,
} from "@/modules/identity/repository";
import type { WorkspaceRole } from "@/modules/identity/workspace";
import { InviteMemberForm, type InvitableRoleOption } from "./invite-form";
import {
  MemberRoleForm,
  RemoveMemberButton,
  RevokeInvitationButton,
  TransferOwnershipButton,
} from "./member-controls";

export const dynamic = "force-dynamic";

const ROLE_LABELS: Record<WorkspaceRole, string> = {
  OWNER: "Propriétaire",
  ADMIN: "Administrateur",
  MEMBER: "Membre",
  VIEWER: "Lecture seule",
};

const INVITATION_STATUS: Record<
  InvitationStatus,
  { label: string; tone: "neutral" | "positive" | "negative" | "warning" }
> = {
  PENDING: { label: "En attente", tone: "neutral" },
  ACCEPTED: { label: "Acceptée", tone: "positive" },
  EXPIRED: { label: "Expirée", tone: "warning" },
  REVOKED: { label: "Révoquée", tone: "neutral" },
};

function roleOptions(roles: readonly WorkspaceRole[]): InvitableRoleOption[] {
  return roles.map((role) => ({ value: role as InvitableRoleOption["value"], label: ROLE_LABELS[role] }));
}

/**
 * « Membres » — who can reach this workspace and how.
 *
 * OWNER and ADMIN only: the page shows addresses, including pending invitations. The
 * owner can never be removed or demoted here; transferring ownership is a separate,
 * explicit action. Every permission is re-checked by the actions and the repository.
 */
export default async function MembersPage() {
  const user = await requirePermission("manage-members");
  const { workspace } = user;

  const [members, invitations] = await Promise.all([
    listWorkspaceMembers(workspace.id),
    listWorkspaceInvitations(workspace.id),
  ]);

  const inviteRoles = roleOptions(
    INVITABLE_ROLES.filter((role) => canGrantRole(workspace.role, role)),
  );

  const now = new Date();

  return (
    <>
      <PageHeader
        title="Membres"
        description={`Membres de l'espace « ${workspace.name} ». Le propriétaire ne peut être ni retiré ni rétrogradé ; la propriété se transfère explicitement à un autre membre.`}
      />

      <Notice tone="info">
        Aucun e-mail n&apos;est envoyé. Une invitation est un lien à transmettre par un
        canal de confiance : il est valable une seule fois, {INVITATION_TTL_DAYS} jours, et
        il est affiché une seule fois. Réinviter une adresse révoque le lien précédent.
      </Notice>

      <Notice tone="warning">
        Les scopes privés et partagés (M8-02) n&apos;existent pas encore : une personne
        invitée accède à toutes les données de cet espace, avec les droits de son rôle
        (un membre peut les modifier, une lecture seule peut les consulter). N&apos;invitez
        que des personnes de confiance.
      </Notice>

      <Card
        title="Inviter une personne"
        description="Les rôles proposés dépendent du vôtre. Un administrateur ne peut pas inviter un autre administrateur."
      >
        <InviteMemberForm roles={inviteRoles} />
      </Card>

      <Card
        title={`Membres (${members.length})`}
        description="Retirer un membre arrête son accès à sa prochaine requête. Ses données restent dans l'espace."
      >
        {members.length === 0 ? (
          <EmptyState
            title="Aucun membre"
            description="Cet espace n'a aucun membre : vérifiez la base ou le script de départ."
          />
        ) : (
          <TableShell caption="Membres de l'espace">
            <thead>
              <tr>
                <th className={thClass}>Membre</th>
                <th className={thClass}>Rôle</th>
                <th className={thClass}>Depuis</th>
                <th className={thClass}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {members.map((member) => {
                const isCurrent = member.userId === user.id;
                const memberLabel = member.name ?? member.email;
                const manageableRoles = roleOptions(
                  INVITABLE_ROLES.filter((role) =>
                    canChangeMemberRole(workspace.role, member.role, role),
                  ),
                );
                const canRemove = canRemoveMember(workspace.role, member.role);
                const canTransfer =
                  workspace.role === "OWNER" && member.role !== "OWNER";

                return (
                  <tr key={member.id}>
                    <td className={tdClass}>
                      <span className="flex flex-wrap items-center gap-2 font-medium">
                        {member.name ?? "Sans nom"}
                        {isCurrent ? <Badge tone="positive">Vous</Badge> : null}
                      </span>
                      <span className="block text-xs text-zinc-500 dark:text-zinc-400">
                        {member.email}
                      </span>
                    </td>
                    <td className={tdClass}>
                      <Badge tone={member.role === "OWNER" ? "positive" : "neutral"}>
                        {ROLE_LABELS[member.role]}
                      </Badge>
                    </td>
                    <td className={tdClass}>{formatInstant(member.joinedAt)}</td>
                    <td className={tdClass}>
                      <div className="flex flex-row gap-2">
                        {manageableRoles.length > 0 ? (
                          <MemberRoleForm
                            userId={member.userId}
                            currentRole={member.role}
                            roles={manageableRoles}
                          />
                        ) : null}
                        {canTransfer ? (
                          <TransferOwnershipButton
                            userId={member.userId}
                            memberLabel={memberLabel}
                          />
                        ) : null}
                        {canRemove ? (
                          <RemoveMemberButton userId={member.userId} memberLabel={memberLabel} />
                        ) : null}
                        {manageableRoles.length === 0 && !canTransfer && !canRemove ? (
                          <span className="text-xs text-zinc-500 dark:text-zinc-400">
                            {member.role === "OWNER"
                              ? "Le propriétaire ne peut pas être retiré ni rétrogradé ici."
                              : "Aucune action possible avec votre rôle."}
                          </span>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </TableShell>
        )}
      </Card>

      <Card
        title="Invitations"
        description="Liens non encore acceptés, expirés ou révoqués. Une invitation acceptée apparaît dans la liste des membres."
      >
        {invitations.length === 0 ? (
          <EmptyState
            title="Aucune invitation"
            description="Invitez une personne ci-dessus pour partager cet espace. Le lien devra être transmis manuellement."
          />
        ) : (
          <TableShell caption="Invitations de l'espace">
            <thead>
              <tr>
                <th className={thClass}>Adresse</th>
                <th className={thClass}>Rôle</th>
                <th className={thClass}>Créée le</th>
                <th className={thClass}>Expire le</th>
                <th className={thClass}>Statut</th>
                <th className={thClass}>Action</th>
              </tr>
            </thead>
            <tbody>
              {invitations.map((invitation) => {
                const status = invitationStatus(invitation, now);
                const statusLabel = INVITATION_STATUS[status];

                return (
                  <tr key={invitation.id}>
                    <td className={tdClass}>{invitation.email}</td>
                    <td className={tdClass}>{ROLE_LABELS[invitation.role]}</td>
                    <td className={tdClass}>{formatInstant(invitation.createdAt)}</td>
                    <td className={tdClass}>{formatInstant(invitation.expiresAt)}</td>
                    <td className={tdClass}>
                      <Badge tone={statusLabel.tone}>{statusLabel.label}</Badge>
                    </td>
                    <td className={tdClass}>
                      {status === "PENDING" ? (
                        <RevokeInvitationButton invitationId={invitation.id} />
                      ) : (
                        <span className="text-xs text-zinc-500 dark:text-zinc-400">
                          Aucune action.
                        </span>
                      )}
                    </td>
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
