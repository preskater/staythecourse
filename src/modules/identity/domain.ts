import { z } from "zod";

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
