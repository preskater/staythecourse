import { z } from "zod";
import type { WorkspaceRole } from "@/modules/identity/workspace";

/**
 * Identity module contracts.
 *
 * The dashboard has a single owner, created by the seed script, and the account
 * page is the only thing that ever changes a credential. The rules are therefore
 * stated once, here, and applied twice: in the browser through react-hook-form,
 * and on the server before any write.
 */

/**
 * Minimum length, and the only composition rule.
 *
 * Length is what actually resists guessing; forcing a symbol and a digit mostly
 * pushes people towards `Password1!`. This is a deliberate trade-off, not an
 * oversight: one owner, one password, no rotation policy.
 */
export const PASSWORD_MIN_LENGTH = 12;

/**
 * bcrypt reads only the first 72 bytes of a password. Past that, two different
 * passwords would open the same account, so the limit is enforced instead of
 * silently ignored. It is counted in bytes, not characters: an accented letter
 * weighs two.
 */
export const PASSWORD_MAX_BYTES = 72;

/** Byte length, without `Buffer`: this schema also runs in the browser. */
function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

export const newPasswordSchema = z
  .string()
  .min(
    PASSWORD_MIN_LENGTH,
    `Le mot de passe doit contenir au moins ${PASSWORD_MIN_LENGTH} caractères.`,
  )
  .refine(
    (value) => value.trim().length > 0,
    "Le mot de passe ne peut pas être composé uniquement d'espaces.",
  )
  .refine(
    (value) => byteLength(value) <= PASSWORD_MAX_BYTES,
    `Le mot de passe ne peut pas dépasser ${PASSWORD_MAX_BYTES} octets (une lettre accentuée compte pour deux).`,
  );

/**
 * A password change.
 *
 * The current password is part of the contract, not a comfort: without it, anyone
 * holding an open session could lock the owner out of their own data.
 *
 * Values are never trimmed. A space is a legitimate character, and silently
 * removing one would mean storing something other than what was typed — the
 * sign-in form does not trim either.
 */
export const passwordChangeSchema = z
  .object({
    currentPassword: z.string().min(1, "Saisissez votre mot de passe actuel."),
    newPassword: newPasswordSchema,
    confirmPassword: z.string().min(1, "Confirmez le nouveau mot de passe."),
  })
  .refine((values) => values.newPassword === values.confirmPassword, {
    message: "Les deux saisies ne correspondent pas.",
    path: ["confirmPassword"],
  })
  .refine((values) => values.newPassword !== values.currentPassword, {
    message: "Le nouveau mot de passe doit être différent de l'actuel.",
    path: ["newPassword"],
  });

export type PasswordChangeInput = z.infer<typeof passwordChangeSchema>;

/**
 * Roles an invitation may grant. `OWNER` is deliberately absent: ownership is
 * transferred by an explicit action, never accepted from a link.
 */
export const INVITABLE_ROLES = [
  "ADMIN",
  "MEMBER",
  "VIEWER",
] as const satisfies readonly WorkspaceRole[];

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

/** 32 random bytes, base64url: 43 characters, no padding. */
const INVITATION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const invitationTokenSchema = z
  .string()
  .regex(INVITATION_TOKEN_PATTERN, "Lien d'invitation invalide.");

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

/** Coarse client families of a persisted session (matches the Prisma enum). */
export type SessionClientKind = "WEB" | "MOBILE" | "UNKNOWN";

/**
 * Client family of a sign-in, from the request's User-Agent header.
 *
 * The header is read once and never stored: only this coarse label is kept, so two
 * sessions stay distinguishable without keeping anything that could fingerprint a
 * device.
 */
export function clientKindFromUserAgent(
  userAgent: string | null | undefined,
): SessionClientKind {
  if (!userAgent) {
    return "UNKNOWN";
  }

  return /Mobile|Android|iPhone|iPad|iPod/i.test(userAgent) ? "MOBILE" : "WEB";
}
