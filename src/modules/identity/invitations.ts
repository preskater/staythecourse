import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { newPasswordSchema } from "@/modules/identity/domain";
import type { WorkspaceRole } from "@/modules/identity/workspace";

/**
 * Workspace invitations (M8-01).
 *
 * A link is a bearer secret: whoever holds it can bind the invited address to an
 * account. It is therefore single-use, expiring and revocable, and only its SHA-256
 * digest is stored. The token is 256 bits from `randomBytes`, so the digest needs no
 * salt or key: guessing one is infeasible, and the digest is useless for signing in.
 *
 * The state is derived from three stamps instead of a status column: `acceptedAt`,
 * `revokedAt` and `expiresAt`. A second stored status could drift from them.
 */

/** How long an invitation stays usable. Short enough to limit a leaked link. */
export const INVITATION_TTL_DAYS = 7;

/** 32 random bytes, base64url: 43 characters, no padding. */
const INVITATION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type InvitationStatus = "PENDING" | "ACCEPTED" | "REVOKED" | "EXPIRED";

export function invitationStatus(
  invitation: { acceptedAt: Date | null; revokedAt: Date | null; expiresAt: Date },
  now: Date = new Date(),
): InvitationStatus {
  if (invitation.acceptedAt) return "ACCEPTED";
  if (invitation.revokedAt) return "REVOKED";
  if (invitation.expiresAt.getTime() <= now.getTime()) return "EXPIRED";
  return "PENDING";
}

export function createInvitationToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");

  return { token, tokenHash: hashInvitationToken(token) };
}

export function hashInvitationToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function invitationExpiry(now: Date = new Date()): Date {
  return new Date(now.getTime() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000);
}

export const invitationTokenSchema = z
  .string()
  .regex(INVITATION_TOKEN_PATTERN, "Lien d'invitation invalide.");

/**
 * Roles an invitation may grant. `OWNER` is deliberately absent: ownership is
 * transferred by an explicit action, never accepted from a link.
 */
export const INVITABLE_ROLES = ["ADMIN", "MEMBER", "VIEWER"] as const satisfies readonly WorkspaceRole[];

export type InvitableRole = (typeof INVITABLE_ROLES)[number];

export const inviteMemberSchema = z.object({
  // The address is trimmed before validation: a pasted value often carries spaces.
  email: z
    .string()
    .trim()
    .pipe(z.email("Adresse e-mail invalide.").max(254, "Adresse e-mail trop longue.")),
  role: z.enum(INVITABLE_ROLES, { message: "Rôle invité invalide." }),
});

export type InviteMemberInput = z.infer<typeof inviteMemberSchema>;

/**
 * Accepting an invitation.
 *
 * The address never comes from the browser: it is read from the invitation row, so a
 * forged form cannot bind the membership to another address. The password is the new
 * account's password, or the existing account's; the same length rule applies because
 * every account created by the seed already meets it.
 */
export const acceptInvitationSchema = z.object({
  token: invitationTokenSchema,
  password: newPasswordSchema,
  name: z
    .string()
    .trim()
    .max(100, "Le nom ne peut pas dépasser 100 caractères.")
    .optional(),
});

export type AcceptInvitationInput = z.infer<typeof acceptInvitationSchema>;
