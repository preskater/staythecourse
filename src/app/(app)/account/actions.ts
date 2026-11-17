"use server";

import { signOut } from "@/auth";
import {
  invalidResult,
  rejectedResult,
  unexpectedResult,
  type ActionResult,
} from "@/lib/actions";
import { requireUser } from "@/lib/auth/guard";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { recordAuditEventSafely } from "@/modules/audit/repository";
import { passwordChangeSchema } from "@/modules/identity/domain";
import { findOwnerById, updateOwnerPassword } from "@/modules/identity/repository";

/**
 * Replaces the owner's password.
 *
 * The current password is required and verified. That is not a comfort: without
 * it, anyone holding an open session — a shared machine, a copied cookie — could
 * lock the owner out of their own data. The verification is a bcrypt comparison,
 * which also bounds how fast this endpoint can be probed.
 *
 * A successful change signs every session out, this one included: the token check
 * lives in `getSessionUser`. Re-authenticating is also what proves the new password
 * works, which a success message would not.
 */

/** Shown when the session no longer names a row: only signing in again fixes it. */
const SESSION_MESSAGE = "Compte introuvable : reconnectez-vous.";

export async function changePasswordAction(values: unknown): Promise<ActionResult> {
  const user = await requireUser();

  const parsed = passwordChangeSchema.safeParse(values);
  if (!parsed.success) {
    return invalidResult(parsed.error);
  }

  const owner = await findOwnerById(user.id);
  if (!owner) {
    return rejectedResult("currentPassword", SESSION_MESSAGE);
  }

  if (!(await verifyPassword(parsed.data.currentPassword, owner.passwordHash))) {
    await recordAuditEventSafely({
      workspaceId: user.workspace.id,
      actorId: user.id,
      action: "auth.password_change_refused",
      entityType: "USER",
      entityId: user.id,
      outcome: "REFUSED",
      metadata: { code: "INVALID_CURRENT_PASSWORD" },
    });
    return rejectedResult("currentPassword", "Mot de passe actuel incorrect.");
  }

  let passwordHash: string;
  try {
    // Hashing happens before the write, so a failure here cannot leave the account
    // with no usable password.
    passwordHash = await hashPassword(parsed.data.newPassword);
  } catch (error) {
    return unexpectedResult("changePassword", error);
  }

  try {
    if (!(await updateOwnerPassword(user.id, passwordHash))) {
      await recordAuditEventSafely({
        workspaceId: user.workspace.id,
        actorId: user.id,
        action: "auth.password_change_refused",
        entityType: "USER",
        entityId: user.id,
        outcome: "REFUSED",
        metadata: { code: "OWNER_NOT_FOUND" },
      });
      return rejectedResult("currentPassword", SESSION_MESSAGE);
    }
  } catch (error) {
    await recordAuditEventSafely({
      workspaceId: user.workspace.id,
      actorId: user.id,
      action: "auth.password_change",
      entityType: "USER",
      entityId: user.id,
      outcome: "FAILED",
      metadata: { code: "WRITE_FAILED" },
    });
    return unexpectedResult("changePassword", error);
  }

  await recordAuditEventSafely({
    workspaceId: user.workspace.id,
    actorId: user.id,
    action: "auth.password_change",
    entityType: "USER",
    entityId: user.id,
    outcome: "SUCCESS",
  });

  // Deliberately outside the blocks above: `signOut` signals success by throwing a
  // redirect, and a surrounding catch would turn a stored change into an error
  // message while the password had already been replaced.
  await signOut({ redirectTo: "/login?changed=1" });

  // Unreachable, `signOut` never returns. Kept for the declared return type.
  return { status: "ok" };
}
