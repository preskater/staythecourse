/**
 * Workspaces: personal, family or company spaces a user reaches through a membership.
 *
 * Server-side only. The active workspace is resolved on every request from the
 * memberships stored in the database, never from a value the browser could choose
 * on its own.
 */

import type { ModuleKey } from "@/modules/catalog/catalog";

export type WorkspaceRole = "OWNER" | "ADMIN" | "MEMBER" | "VIEWER";
export type WorkspaceKind = "PERSONAL" | "FAMILY" | "COMPANY";

/**
 * One of the session user's memberships, with the role it grants there and the
 * modules active in that workspace (see `activeModules`).
 */
export type ActiveWorkspace = {
  id: string;
  name: string;
  kind: WorkspaceKind;
  role: WorkspaceRole;
  modules: readonly ModuleKey[];
};

/** Identifier of the personal workspace every owner gets; matches the migration backfill. */
export function defaultWorkspaceId(userId: string): string {
  return `ws-${userId}`;
}

/**
 * Picks the workspace a request works in, among the user's own memberships (oldest
 * first).
 *
 * - No membership: `null`, and the caller refuses the session.
 * - A requested identifier the user is not a member of: `null` as well — a foreign
 *   workspace reads as "not found", never as "forbidden", so its existence leaks nothing.
 * - Nothing requested: the oldest membership, so the choice is stable across requests.
 */
export function resolveActiveWorkspace(
  memberships: readonly ActiveWorkspace[],
  requestedId?: string | null,
): ActiveWorkspace | null {
  if (requestedId) {
    return memberships.find((membership) => membership.id === requestedId) ?? null;
  }

  return memberships[0] ?? null;
}
