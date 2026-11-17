import type { ActionResult } from "@/lib/actions";
import { requireModule, type SessionUser } from "@/lib/auth/guard";
import { canManageBusinessRecords } from "@/modules/identity/workspace";

/**
 * Shared write guard for the micro-business Server Actions.
 *
 * The session and the module entitlement come first, then the role: only the
 * workspace's owner and admins write commercial records. A `MEMBER` or `VIEWER` reads
 * them and writes nothing. Every identifier from the browser is still looked up
 * workspace-scoped by the caller, so a foreign one is "not found".
 */
export const BUSINESS_MANAGER_MESSAGE =
  "Seuls le propriétaire et les administrateurs de l'espace peuvent modifier les clients, les projets et les revenus.";

export type BusinessManagerGuard = { user: SessionUser } | { refusal: ActionResult };

export async function requireBusinessManager(): Promise<BusinessManagerGuard> {
  const user = await requireModule("micro-business", "write");

  if (!canManageBusinessRecords(user.workspace.role)) {
    return { refusal: { status: "error", message: BUSINESS_MANAGER_MESSAGE } };
  }

  return { user };
}
