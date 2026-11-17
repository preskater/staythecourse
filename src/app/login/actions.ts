"use server";

import { AuthError } from "next-auth";
import { redirect } from "next/navigation";
import { z } from "zod";
import { signIn } from "@/auth";
import { getSessionUser } from "@/lib/auth/guard";
import { recordAuditEventSafely } from "@/modules/audit/repository";
import { revokeSession } from "@/modules/identity/sessions";

/** Sign-in and sign-out actions. Both run on the server only. */

const loginSchema = z.object({
  email: z.string().min(3),
  password: z.string().min(1),
});

export async function loginAction(formData: FormData): Promise<void> {
  const parsed = loginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    redirect("/login?error=invalid");
  }

  try {
    await signIn("credentials", {
      email: parsed.data.email,
      password: parsed.data.password,
      redirectTo: "/dashboard",
    });
  } catch (error) {
    // `signIn` signals a successful sign-in by throwing a redirect: it must be
    // rethrown, otherwise the user stays on the form with no session.
    if (error instanceof AuthError) {
      redirect("/login?error=credentials");
    }
    throw error;
  }
}

export async function signOutAction(): Promise<void> {
  // Revoke the persisted row too, otherwise a signed-out device would stay listed as
  // an active session forever. A database failure must not trap the owner on the
  // page: the cookie is still cleared below.
  try {
    const user = await getSessionUser();
    if (user) {
      await revokeSession(user.id, user.sessionId);
      await recordAuditEventSafely({
        workspaceId: user.workspace.id,
        actorId: user.id,
        action: "auth.sign_out",
        entityType: "SESSION",
        entityId: user.sessionId,
        outcome: "SUCCESS",
      });
    }
  } catch (error) {
    console.error(
      `[signOut] ${error instanceof Error ? error.name : typeof error}`,
    );
  }

  const { signOut } = await import("@/auth");
  await signOut({ redirectTo: "/login" });
}
