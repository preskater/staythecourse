import { createHash, randomBytes } from "node:crypto";

// The browser validates with the same contract, so it lives in `domain` (this module
// pulls in `node:crypto` and cannot reach a client component).
export {
  INVITABLE_ROLES,
  acceptInvitationSchema,
  invitationTokenSchema,
  inviteMemberSchema,
  type AcceptInvitationInput,
  type InvitableRole,
  type InviteMemberInput,
} from "@/modules/identity/domain";

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
