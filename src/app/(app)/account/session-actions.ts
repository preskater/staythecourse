"use server";

import { z } from "zod";
import { signOut } from "@/auth";
import { rejectedResult, unexpectedResult, type ActionResult } from "@/lib/actions";
import { requireUser } from "@/lib/auth/guard";
import { recordAuditEventSafely } from "@/modules/audit/repository";
import { revokeOtherSessions, revokeSession } from "@/modules/identity/sessions";

/**
 * Revocation of persisted sessions.
 *
 * Every query is scoped to the signed-in owner, so a foreign, unknown, malformed or
 * already-revoked identifier is answered with the same sentence. No response ever
 * carries a token, a session identifier or any other secret.
 */

const sessionIdInput = z.object({
  id: z.string().trim().min(1),
});

/** Deliberately the same for malformed, unknown, foreign and revoked ids. */
const NOT_FOUND_MESSAGE = "Session introuvable.";

export async function revokeSessionAction(values: unknown): Promise<ActionResult> {
  const user = await requireUser();

  const parsed = sessionIdInput.safeParse(values);
  if (!parsed.success) {
    return rejectedResult("id", NOT_FOUND_MESSAGE);
  }

  let revoked: boolean;
  try {
    // Scoped by owner inside the query, not compared afterwards.
    revoked = await revokeSession(user.id, parsed.data.id);
  } catch (error) {
    return unexpectedResult("revokeSession", error);
  }

  if (!revoked) {
    return rejectedResult("id", NOT_FOUND_MESSAGE);
  }

  await recordAuditEventSafely({
    workspaceId: user.workspace.id,
    actorId: user.id,
    action: "auth.session_revoke",
    entityType: "SESSION",
    entityId: parsed.data.id,
    outcome: "SUCCESS",
    metadata: { scope: "ONE" },
  });

  // The interface does not offer this, but a hand-made request can. Revoking the
  // session making the call signs it out immediately: the token is refused from the
  // next request on, so answering "ok" would leave the page unusable anyway.
  if (parsed.data.id === user.sessionId) {
    await signOut({ redirectTo: "/login?revoked=1" });
  }

  return { status: "ok", message: "Session révoquée." };
}

export async function revokeOtherSessionsAction(): Promise<ActionResult> {
  const user = await requireUser();

  try {
    const count = await revokeOtherSessions(user.id, user.sessionId);

    if (count > 0) {
      await recordAuditEventSafely({
        workspaceId: user.workspace.id,
        actorId: user.id,
        action: "auth.session_revoke",
        entityType: "SESSION",
        outcome: "SUCCESS",
        metadata: { scope: "OTHERS", count },
      });
    }

    return {
      status: "ok",
      message:
        count === 0
          ? "Aucune autre session active."
          : `${count} session${count > 1 ? "s" : ""} révoquée${count > 1 ? "s" : ""}.`,
    };
  } catch (error) {
    return unexpectedResult("revokeOtherSessions", error);
  }
}
