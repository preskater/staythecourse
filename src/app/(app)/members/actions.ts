"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  invalidResult,
  rejectedResult,
  unexpectedResult,
  type ActionResult,
} from "@/lib/actions";
import { requireUser } from "@/lib/auth/guard";
import { formatInstant } from "@/lib/dates";
import { recordAuditEventSafely } from "@/modules/audit/repository";
import {
  INVITABLE_ROLES,
  createInvitationToken,
  invitationExpiry,
  inviteMemberSchema,
} from "@/modules/identity/invitations";
import { canGrantRole, hasPermission } from "@/modules/identity/permissions";
import {
  changeWorkspaceMemberRole,
  createWorkspaceInvitation,
  removeWorkspaceMember,
  revokeWorkspaceInvitation,
  transferWorkspaceOwnership,
} from "@/modules/identity/repository";
import type { WorkspaceRole } from "@/modules/identity/workspace";

/**
 * Membership lifecycle Server Actions (M8-01).
 *
 * The workspace and the actor always come from the session; the browser names only a
 * member, an invitation or an address, and the repository re-reads both roles before
 * writing. A refusal reveals nothing about the database beyond the operation itself.
 */

const MANAGE_MESSAGE =
  "Seuls le propriétaire et les administrateurs de l'espace peuvent gérer ses membres.";

export type InviteMemberActionResult =
  | {
      status: "ok";
      message: string;
      invitationUrl: string;
      expiresLabel: string;
    }
  | Extract<ActionResult, { status: "invalid" }>
  | Extract<ActionResult, { status: "error" }>;

/**
 * Absolute link built from the configured origin, falling back to the request's
 * forwarded headers. The token is part of the path and is never logged.
 */
async function absoluteInvitationUrl(token: string): Promise<string> {
  const path = `/invitation/${token}`;
  const configured = process.env.AUTH_URL?.replace(/\/+$/, "");
  if (configured) {
    return `${configured}${path}`;
  }

  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host");
  if (!host) {
    return path;
  }

  const protocol = requestHeaders.get("x-forwarded-proto") ?? "http";
  return `${protocol}://${host}${path}`;
}

export async function inviteMemberAction(
  values: unknown,
): Promise<InviteMemberActionResult> {
  const user = await requireUser();

  if (!hasPermission(user.workspace.role, "manage-members")) {
    return { status: "error", message: MANAGE_MESSAGE };
  }

  const parsed = inviteMemberSchema.safeParse(values);
  if (!parsed.success) {
    return invalidResult(parsed.error);
  }

  if (!canGrantRole(user.workspace.role, parsed.data.role)) {
    return rejectedResult("role", "Vous ne pouvez pas attribuer ce rôle.");
  }

  const now = new Date();
  const expiresAt = invitationExpiry(now);
  const { token, tokenHash } = createInvitationToken();

  let created;
  try {
    created = await createWorkspaceInvitation({
      workspaceId: user.workspace.id,
      actorId: user.id,
      email: parsed.data.email,
      role: parsed.data.role,
      tokenHash,
      expiresAt,
      now,
    });
  } catch (error) {
    return unexpectedResult("createWorkspaceInvitation", error);
  }

  if (created.status === "forbidden") {
    return rejectedResult("role", "Vous ne pouvez pas attribuer ce rôle.");
  }
  if (created.status === "already_member") {
    return rejectedResult("email", "Cette personne est déjà membre de cet espace.");
  }

  await recordAuditEventSafely({
    workspaceId: user.workspace.id,
    actorId: user.id,
    action: "workspace.invite",
    entityType: "INVITATION",
    entityId: created.id,
    outcome: "SUCCESS",
    // `replaced` says how many older live links this invite revoked; the address
    // itself never enters the trail.
    metadata: { role: parsed.data.role, replaced: created.replaced },
  });

  revalidatePath("/members");

  const expiresLabel = formatInstant(expiresAt);

  return {
    status: "ok",
    message: `Invitation créée. Le lien est valable une seule fois, jusqu'au ${expiresLabel}.`,
    invitationUrl: await absoluteInvitationUrl(token),
    expiresLabel,
  };
}

const invitationIdInput = z.object({ invitationId: z.string().trim().min(1) });

export async function revokeInvitationAction(values: unknown): Promise<ActionResult> {
  const user = await requireUser();

  if (!hasPermission(user.workspace.role, "manage-members")) {
    return { status: "error", message: MANAGE_MESSAGE };
  }

  const parsed = invitationIdInput.safeParse(values);
  if (!parsed.success) {
    return rejectedResult("invitationId", "Invitation introuvable.");
  }

  let result;
  try {
    result = await revokeWorkspaceInvitation({
      workspaceId: user.workspace.id,
      actorId: user.id,
      invitationId: parsed.data.invitationId,
    });
  } catch (error) {
    return unexpectedResult("revokeWorkspaceInvitation", error);
  }

  if (result === "forbidden") {
    return { status: "error", message: MANAGE_MESSAGE };
  }
  if (result === "not_found") {
    return rejectedResult(
      "invitationId",
      "Invitation introuvable, déjà utilisée ou déjà révoquée.",
    );
  }

  await recordAuditEventSafely({
    workspaceId: user.workspace.id,
    actorId: user.id,
    action: "workspace.invitation_revoke",
    entityType: "INVITATION",
    entityId: parsed.data.invitationId,
    outcome: "SUCCESS",
  });

  revalidatePath("/members");
  return { status: "ok", message: "Invitation révoquée." };
}

const memberIdInput = z.object({ userId: z.string().trim().min(1) });

export async function removeMemberAction(values: unknown): Promise<ActionResult> {
  const user = await requireUser();

  if (!hasPermission(user.workspace.role, "manage-members")) {
    return { status: "error", message: MANAGE_MESSAGE };
  }

  const parsed = memberIdInput.safeParse(values);
  if (!parsed.success) {
    return rejectedResult("userId", "Membre introuvable.");
  }

  let result;
  try {
    result = await removeWorkspaceMember({
      workspaceId: user.workspace.id,
      actorId: user.id,
      targetUserId: parsed.data.userId,
    });
  } catch (error) {
    return unexpectedResult("removeWorkspaceMember", error);
  }

  if (result === "forbidden") {
    return {
      status: "error",
      message:
        "Ce membre ne peut pas être retiré : le propriétaire de l'espace ne l'est jamais, et votre rôle ne permet pas ce retrait.",
    };
  }
  if (result === "not_found") {
    return rejectedResult("userId", "Membre introuvable.");
  }

  await recordAuditEventSafely({
    workspaceId: user.workspace.id,
    actorId: user.id,
    action: "workspace.member_remove",
    entityType: "USER",
    entityId: parsed.data.userId,
    outcome: "SUCCESS",
  });

  revalidatePath("/members");
  return { status: "ok", message: "Membre retiré de l'espace." };
}

const memberRoleInput = z.object({
  userId: z.string().trim().min(1),
  role: z.enum(INVITABLE_ROLES),
});

export async function changeMemberRoleAction(values: unknown): Promise<ActionResult> {
  const user = await requireUser();

  if (!hasPermission(user.workspace.role, "manage-members")) {
    return { status: "error", message: MANAGE_MESSAGE };
  }

  const parsed = memberRoleInput.safeParse(values);
  if (!parsed.success) {
    return invalidResult(parsed.error);
  }

  const nextRole: WorkspaceRole = parsed.data.role;
  if (!canGrantRole(user.workspace.role, nextRole)) {
    // A quick refusal before the repository reads the target: the real check happens
    // there against the target's current role.
    return rejectedResult("role", "Vous ne pouvez pas attribuer ce rôle.");
  }

  let result;
  try {
    result = await changeWorkspaceMemberRole({
      workspaceId: user.workspace.id,
      actorId: user.id,
      targetUserId: parsed.data.userId,
      role: nextRole,
    });
  } catch (error) {
    return unexpectedResult("changeWorkspaceMemberRole", error);
  }

  if (result === "forbidden") {
    return rejectedResult("role", "Vous ne pouvez pas attribuer ce rôle à ce membre.");
  }
  if (result === "not_found") {
    return rejectedResult("userId", "Membre introuvable.");
  }

  await recordAuditEventSafely({
    workspaceId: user.workspace.id,
    actorId: user.id,
    action: "workspace.member_role_change",
    entityType: "USER",
    entityId: parsed.data.userId,
    outcome: "SUCCESS",
    metadata: { role: nextRole },
  });

  revalidatePath("/members");
  return { status: "ok", message: "Rôle modifié." };
}

const transferOwnershipInput = z.object({ userId: z.string().trim().min(1) });

export async function transferOwnershipAction(values: unknown): Promise<ActionResult> {
  const user = await requireUser();

  if (user.workspace.role !== "OWNER") {
    return {
      status: "error",
      message: "Seul le propriétaire actuel de l'espace peut transférer sa propriété.",
    };
  }

  const parsed = transferOwnershipInput.safeParse(values);
  if (!parsed.success) {
    return rejectedResult("userId", "Membre introuvable.");
  }

  let result;
  try {
    result = await transferWorkspaceOwnership({
      workspaceId: user.workspace.id,
      actorId: user.id,
      targetUserId: parsed.data.userId,
    });
  } catch (error) {
    return unexpectedResult("transferWorkspaceOwnership", error);
  }

  if (result === "forbidden") {
    return {
      status: "error",
      message:
        "Transfert impossible : seul le propriétaire actuel peut transférer, et la cible doit être un autre membre.",
    };
  }
  if (result === "not_found") {
    return rejectedResult("userId", "Membre introuvable.");
  }

  await recordAuditEventSafely({
    workspaceId: user.workspace.id,
    actorId: user.id,
    action: "workspace.ownership_transfer",
    entityType: "USER",
    entityId: parsed.data.userId,
    outcome: "SUCCESS",
    metadata: { role: "OWNER" },
  });

  revalidatePath("/members");
  return {
    status: "ok",
    message: "Propriété transférée. Vous êtes désormais administrateur de l'espace.",
  };
}
