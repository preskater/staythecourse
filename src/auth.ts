import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { z } from "zod";
import { authConfig } from "@/auth.config";
import { burnPasswordComparison, passwordTag, verifyPassword } from "@/lib/auth/password";
import type { AuditAction, AuditOutcome } from "@/modules/audit/domain";
import { recordAuditEventSafely } from "@/modules/audit/repository";
import { clientKindFromUserAgent } from "@/modules/identity/domain";
import {
  findOwnerByEmail,
  listMemberships,
  normaliseEmail,
} from "@/modules/identity/repository";
import { createSession } from "@/modules/identity/sessions";
import { resolveActiveWorkspace } from "@/modules/identity/workspace";

/**
 * Server-side Auth.js instance.
 *
 * A single owner signs in with an email and a password. There is no public
 * sign-up: accounts are created by `npm run db:seed`.
 */
const credentialsSchema = z.object({
  email: z.string().min(3),
  password: z.string().min(1),
});

/**
 * Records an authentication event in the owner's own workspace.
 *
 * The address and the password never reach the trail: a refusal carries a denial code
 * only. The write is best-effort — an audit outage must not lock the owner out — and
 * an unknown address writes nothing, because there is no workspace to scope it to.
 */
async function recordAuthEvent(input: {
  ownerId: string;
  action: AuditAction;
  outcome: AuditOutcome;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    const workspace = resolveActiveWorkspace(await listMemberships(input.ownerId));
    if (!workspace) return;

    await recordAuditEventSafely({
      workspaceId: workspace.id,
      actorId: input.ownerId,
      action: input.action,
      entityType: "SESSION",
      entityId: input.entityId ?? null,
      outcome: input.outcome,
      metadata: input.metadata,
    });
  } catch (error) {
    console.error(`[auth-audit] ${error instanceof Error ? error.name : typeof error}`);
  }
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      credentials: {
        email: { label: "Adresse e-mail", type: "email" },
        password: { label: "Mot de passe", type: "password" },
      },
      /**
       * Returns `null` for every failure: the caller must not learn whether the
       * address exists, only that the pair is wrong.
       */
      async authorize(rawCredentials, request) {
        const parsed = credentialsSchema.safeParse(rawCredentials);
        if (!parsed.success) {
          return null;
        }

        const owner = await findOwnerByEmail(normaliseEmail(parsed.data.email));

        if (!owner) {
          await burnPasswordComparison(parsed.data.password);
          return null;
        }

        const isPasswordValid = await verifyPassword(
          parsed.data.password,
          owner.passwordHash,
        );
        if (!isPasswordValid) {
          await recordAuthEvent({
            ownerId: owner.id,
            action: "auth.sign_in_refused",
            outcome: "REFUSED",
            metadata: { code: "INVALID_CREDENTIALS" },
          });
          return null;
        }

        // Created only after the password is verified. The row is what the owner can
        // revoke later; the token carries its identifier, and the guard refuses a
        // token whose row is missing, revoked or owned by someone else. The client
        // family comes from this request and the header itself is not kept.
        const client = clientKindFromUserAgent(request?.headers.get("user-agent"));
        const sessionId = await createSession(owner.id, client);

        await recordAuthEvent({
          ownerId: owner.id,
          action: "auth.sign_in",
          outcome: "SUCCESS",
          entityId: sessionId,
          metadata: { client },
        });

        return {
          id: owner.id,
          email: owner.email,
          name: owner.name ?? undefined,
          // Fingerprint of the hash this session is issued for, so a later password
          // change can sign it out (see `getSessionUser`).
          passwordTag: passwordTag(owner.passwordHash),
          sessionId,
        };
      },
    }),
  ],
  callbacks: {
    ...authConfig.callbacks,
    // Only the identifier travels in the token; no password hash, no token, no budget data.
    jwt({ token, user }) {
      if (user) {
        token.sub = user.id;
        // A digest, not the hash: enough to detect a change, useless to an attacker.
        token.passwordTag = user.passwordTag;
        // Server-issued identifier of the persisted row. It is never chosen by the
        // browser, so it cannot be fixated.
        token.sessionId = user.sessionId;
      }
      return token;
    },
    session({ session, token }) {
      if (token.sub && session.user) {
        session.user.id = token.sub;
      }
      session.passwordTag = token.passwordTag;
      session.sessionId = token.sessionId;
      return session;
    },
  },
});
