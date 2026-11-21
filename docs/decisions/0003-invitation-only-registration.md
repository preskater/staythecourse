# 0003 — Invitation-only registration and membership lifecycle

- Status: accepted
- Date: 2026-11-13

## Context

M8-01 adds a household membership lifecycle. The application still has no public
sign-up, no e-mail delivery and no way for an operator to create a second account
without database access. An invitation therefore has to onboard a person who may not
have an account yet, while keeping the "no public sign-up" rule and the existing
Auth.js credentials provider.

There is also no workspace switcher: `getSessionUser` resolves the oldest membership.
A brand-new invited person has exactly one membership, so the simplest flow works
without one. A person who already has their own workspace cannot reach a newly joined
workspace until a switcher lands; that limitation is accepted for this milestone.

## Decision

- **The invitation link is the authorisation.** A token is 32 random bytes (256 bits),
  base64url-encoded. Only its SHA-256 digest is stored; the raw token appears once, in
  the inviter's browser response, and is never logged or persisted. The digest needs no
  salt or key: guessing 256 bits is infeasible.
- **Single-use, expiring, revocable.** A link is valid for 7 days. Acceptance and
  revocation are stamped (`acceptedAt`, `revokedAt`); the state is derived from the
  stamps and `expiresAt`, never stored a second time. Re-inviting an address revokes
  its previous live link in the same transaction, so one address has at most one usable
  link per workspace.
- **Invitation-only registration.** The acceptance page asks for a password. The address
  comes from the invitation row, never from the browser. If an account already exists
  for that address, the password is verified; otherwise the account is created in the
  same transaction that consumes the invitation. This is not public sign-up: without a
  valid token, the page creates nothing.
- **No e-mail is sent.** The inviter copies the link and shares it over a channel they
  trust. Losing the link means creating a new invitation, which revokes the old one.
- **Acceptance is bound to the address.** A signed-in account whose address differs is
  refused. An existing membership keeps its current role: an invitation never escalates
  someone already in the workspace.
- **Roles.** OWNER and ADMIN may invite; an admin may grant only MEMBER or VIEWER, and
  nobody grants OWNER through an invitation or a role change. Ownership moves only
  through the explicit owner-only transfer action, which swaps OWNER and ADMIN in one
  transaction.
- **Removal takes effect on the next request.** The guard re-reads memberships on every
  request, so no session revocation is needed for a membership removal.
- **The trail carries no secrets or addresses.** Invitations and membership changes are
  audited through the existing append-only helper; metadata is a role code or a count,
  never the token, the invited address or a password.

## Alternatives considered

- *Operator seeds every account*: rejected. It makes a household member depend on
  server access, which is exactly the problem M8-01 solves.
- *E-mailed invitation links*: rejected for this milestone. It adds an outbound e-mail
  provider, deliverability and a second secret to operate; the product assumes none.
  The link format does not change if e-mail delivery is added later.
- *Public sign-up*: rejected by the product scope. The invitation token is the
  difference between the two.
- *A status column on invitations*: rejected. `acceptedAt`, `revokedAt` and `expiresAt`
  already answer every state, and a duplicated status could drift from them.

## Consequences

- The inviter is responsible for sharing the link safely; a leaked link can be used by
  whoever holds it (with the invited account's password, or to create that account if
  none exists). Expiry, single use and revocation bound the exposure.
- There is no e-mail ownership proof. The invited address is trusted because a manager
  typed it; a typo creates an account for the wrong address, which the manager can
  revoke or remove.
- A user with several memberships keeps resolving the oldest one until a workspace
  switcher exists (M7-01 anticipated it). Invited accounts created by this flow have
  only the household membership, so they land there; an account that already owns a
  workspace does not.
- Until M8-02 adds private/shared scopes, an invited member reaches **every** record of
  the workspace with the rights of their role (a MEMBER can write, a VIEWER reads). The
  members page displays this warning; invitations are for trusted people only.
- Accepted, revoked and expired invitation rows are kept for audit context. They are
  tiny and bounded by a household's membership count; no retention job is added yet.
- The members page is manager-only (OWNER and ADMIN). Other roles cannot read member or
  invitation addresses.
