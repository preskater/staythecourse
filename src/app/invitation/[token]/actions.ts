"use server";

import { AuthError } from "next-auth";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import {
  invalidResult,
  rejectedResult,
  unexpectedResult,
  type ActionResult,
} from "@/lib/actions";
import { signIn } from "@/auth";
import { getSessionUser } from "@/lib/auth/guard";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { recordAuditEventSafely } from "@/modules/audit/repository";
import {
  acceptInvitationSchema,
  hashInvitationToken,
  invitationStatus,
  invitationTokenSchema,
} from "@/modules/identity/invitations";
import {
  acceptWorkspaceInvitation,
  findOwnerByEmail,
  findWorkspaceInvitationByTokenHash,
  normaliseEmail,
  registerAndAcceptWorkspaceInvitation,
} from "@/modules/identity/repository";

/**
 * Invitation acceptance (M8-01).
 *
 * The token is the authorisation, so these actions are reachable without a session.
 * The invited address never comes from the browser: it is read from the invitation
 * row, which is what binds the membership to the right account. A refusal is the same
 * sentence whatever the reason (unknown, expired, revoked, reused, or lost race), so a
 * caller cannot use the form to probe invitations.
 */

const INVALID_MESSAGE =
  "Cette invitation n'est plus valide. Demandez une nouvelle invitation à un membre de l'espace.";

/** A wrong password is the only refusal this page reports for an existing account. */
const SIGN_IN_FAILED = "La connexion a échoué. Vérifiez le mot de passe saisi.";

/** For the signed-in path: a plain form, so a refusal sends the reader back to the page. */
export async function acceptInvitationAsSignedInAction(formData: FormData): Promise<void> {
  const parsedToken = invitationTokenSchema.safeParse(formData.get("token"));
  const token = parsedToken.success ? parsedToken.data : "";

  const user = await getSessionUser();
  if (!user) {
    redirect("/login");
  }

  const invitation = token
    ? await findWorkspaceInvitationByTokenHash(hashInvitationToken(token))
    : null;

  if (
    !invitation ||
    invitationStatus(invitation) !== "PENDING" ||
    normaliseEmail(user.email) !== invitation.email
  ) {
    // The page re-reads the invitation and shows its own state: invalid, already
    // used, or addressed to another account.
    redirect(token ? `/invitation/${token}` : "/login");
  }

  const result = await acceptWorkspaceInvitation({
    tokenHash: hashInvitationToken(token),
    userId: user.id,
    userEmail: user.email,
  });

  if (result.status !== "ok") {
    redirect(`/invitation/${token}`);
  }

  await recordAuditEventSafely({
    workspaceId: result.workspaceId,
    actorId: user.id,
    action: "workspace.invitation_accept",
    entityType: "INVITATION",
    entityId: invitation.id,
    outcome: "SUCCESS",
    metadata: { role: invitation.role },
  });

  revalidatePath("/", "layout");
  redirect("/dashboard");
}

/**
 * Creates the account when the invited address has none, or verifies the existing
 * account's password, then accepts the invitation and signs in.
 */
export async function acceptInvitationAction(values: unknown): Promise<ActionResult> {
  const parsed = acceptInvitationSchema.safeParse(values);
  if (!parsed.success) {
    return invalidResult(parsed.error);
  }

  const tokenHash = hashInvitationToken(parsed.data.token);
  const invitation = await findWorkspaceInvitationByTokenHash(tokenHash);

  if (!invitation || invitationStatus(invitation) !== "PENDING") {
    return { status: "error", message: INVALID_MESSAGE };
  }

  const name = parsed.data.name?.trim() || null;
  const existing = await findOwnerByEmail(invitation.email);

  if (existing) {
    if (!(await verifyPassword(parsed.data.password, existing.passwordHash))) {
      return rejectedResult("password", SIGN_IN_FAILED);
    }

    let accepted;
    try {
      accepted = await acceptWorkspaceInvitation({
        tokenHash,
        userId: existing.id,
        userEmail: existing.email,
      });
    } catch (error) {
      return unexpectedResult("acceptWorkspaceInvitation", error);
    }

    if (accepted.status !== "ok") {
      return { status: "error", message: INVALID_MESSAGE };
    }

    await recordAuditEventSafely({
      workspaceId: accepted.workspaceId,
      actorId: existing.id,
      action: "workspace.invitation_accept",
      entityType: "INVITATION",
      entityId: invitation.id,
      outcome: "SUCCESS",
      metadata: { role: invitation.role },
    });

    revalidatePath("/", "layout");
    return signInAndRedirect(existing.email, parsed.data.password);
  }

  let passwordHash: string;
  try {
    passwordHash = await hashPassword(parsed.data.password);
  } catch (error) {
    return unexpectedResult("acceptInvitation", error);
  }

  let registration;
  try {
    registration = await registerAndAcceptWorkspaceInvitation({
      tokenHash,
      email: invitation.email,
      name,
      passwordHash,
    });
  } catch (error) {
    return unexpectedResult("registerAndAcceptWorkspaceInvitation", error);
  }

  if (registration.status === "account_exists") {
    return {
      status: "error",
      message:
        "Un compte existe déjà pour cette adresse. Rechargez la page et saisissez son mot de passe.",
    };
  }

  if (registration.status !== "ok") {
    return { status: "error", message: INVALID_MESSAGE };
  }

  await recordAuditEventSafely({
    workspaceId: registration.workspaceId,
    actorId: registration.userId,
    action: "workspace.invitation_accept",
    entityType: "INVITATION",
    entityId: invitation.id,
    outcome: "SUCCESS",
    metadata: { role: invitation.role },
  });

  revalidatePath("/", "layout");
  return signInAndRedirect(invitation.email, parsed.data.password);
}

/** `signIn` signals success by throwing a redirect; only an AuthError is an error. */
async function signInAndRedirect(email: string, password: string): Promise<ActionResult> {
  try {
    await signIn("credentials", { email, password, redirectTo: "/dashboard" });
  } catch (error) {
    if (error instanceof AuthError) {
      return {
        status: "error",
        message:
          "Votre compte est prêt, mais la connexion automatique a échoué. Connectez-vous depuis la page de connexion.",
      };
    }
    throw error;
  }

  // Unreachable: `signIn` redirects on success. Kept for the declared return type.
  return { status: "ok" };
}
