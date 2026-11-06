import type { WorkspaceRole } from "@/modules/identity/workspace";

/**
 * Role presets for a workspace membership.
 *
 * The matrix is the single source of truth for what a role may do. Guards compose it
 * with the session and the active workspace (`src/lib/auth/guard.ts`); no page, Server
 * Action or Route Handler re-implements a role comparison.
 *
 * Deny-by-default: a permission absent from a preset is refused, and an unknown role
 * or permission (a value the database should never return) is refused as well.
 *
 * Per the scope of M7-05 these are coarse presets. Fine-grained permissions that split
 * financial, developer, credential, internal-rate, personal-scope and export rights
 * arrive with M18-01; until then `export` follows the write presets.
 */

export const PERMISSIONS = [
  "read",
  "write",
  "export",
  "manage-modules",
  "manage-members",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const ROLE_PERMISSIONS: Readonly<Record<string, ReadonlySet<Permission>>> = {
  OWNER: new Set(PERMISSIONS),
  ADMIN: new Set(PERMISSIONS),
  MEMBER: new Set<Permission>(["read", "write", "export"]),
  // A viewer reads the workspace and nothing else: no write, no export, no settings.
  VIEWER: new Set<Permission>(["read"]),
};

/** @returns whether `role` grants `permission`; `false` for anything unknown. */
export function hasPermission(role: WorkspaceRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.has(permission) ?? false;
}

/**
 * Roles a given role may act on when managing memberships.
 *
 * `OWNER` is deliberately absent from every list: ownership is not demoted or removed
 * through the member-management path, by anyone. Transferring ownership is a separate,
 * explicit operation (M8-01), so an admin can never leave a workspace without an owner.
 */
const MANAGEABLE_ROLES: Readonly<Record<string, readonly WorkspaceRole[]>> = {
  OWNER: ["ADMIN", "MEMBER", "VIEWER"],
  ADMIN: ["MEMBER", "VIEWER"],
  MEMBER: [],
  VIEWER: [],
};

/**
 * Roles a given role may grant. Nobody grants `OWNER` here, and an admin cannot create
 * a peer admin: only the owner promotes to admin.
 */
const GRANTABLE_ROLES: Readonly<Record<string, readonly WorkspaceRole[]>> = {
  OWNER: ["ADMIN", "MEMBER", "VIEWER"],
  ADMIN: ["MEMBER", "VIEWER"],
  MEMBER: [],
  VIEWER: [],
};

function canManageMembership(actorRole: WorkspaceRole, targetRole: WorkspaceRole): boolean {
  if (!hasPermission(actorRole, "manage-members")) {
    return false;
  }

  return MANAGEABLE_ROLES[actorRole]?.includes(targetRole) ?? false;
}

/** @returns whether `actorRole` may remove the membership carrying `targetRole`. */
export function canRemoveMember(
  actorRole: WorkspaceRole,
  targetRole: WorkspaceRole,
): boolean {
  return canManageMembership(actorRole, targetRole);
}

/**
 * @returns whether `actorRole` may move a member from `targetRole` to `nextRole`.
 * An admin can neither demote nor promote the owner, nor grant the owner role.
 */
export function canChangeMemberRole(
  actorRole: WorkspaceRole,
  targetRole: WorkspaceRole,
  nextRole: WorkspaceRole,
): boolean {
  if (!canManageMembership(actorRole, targetRole)) {
    return false;
  }

  return GRANTABLE_ROLES[actorRole]?.includes(nextRole) ?? false;
}
