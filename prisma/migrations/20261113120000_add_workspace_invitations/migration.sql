-- M8-01: household invitations and membership lifecycle.
--
-- The raw token is never stored: `tokenHash` is its SHA-256 digest, and the link is
-- shown once to the inviter. Expiry and single use are stamped, not stored twice:
-- `acceptedAt`, `revokedAt` and `expiresAt` derive the state.
--
-- The role check keeps invitations from ever granting OWNER: ownership is transferred
-- by an explicit action, never accepted from a link.
CREATE TABLE "WorkspaceInvitation" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "WorkspaceRole" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "invitedById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "acceptedAt" TIMESTAMPTZ(3),
    "acceptedByUserId" TEXT,
    "revokedAt" TIMESTAMPTZ(3),

    CONSTRAINT "WorkspaceInvitation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "WorkspaceInvitation_role_check" CHECK ("role" <> 'OWNER')
);

-- One live token per digest: the acceptance lookup is by hash, and a duplicate could
-- never be told apart from the first.
CREATE UNIQUE INDEX "WorkspaceInvitation_tokenHash_key" ON "WorkspaceInvitation"("tokenHash");

-- Re-inviting an address looks up its pending rows inside one workspace; the member
-- and invitation lists read by workspace, most recent first.
CREATE INDEX "WorkspaceInvitation_workspaceId_email_idx"
    ON "WorkspaceInvitation"("workspaceId", "email");
CREATE INDEX "WorkspaceInvitation_workspaceId_createdAt_idx"
    ON "WorkspaceInvitation"("workspaceId", "createdAt");

ALTER TABLE "WorkspaceInvitation"
    ADD CONSTRAINT "WorkspaceInvitation_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- The invitation survives the deletion of the people who sent or accepted it; only
-- the reference is dropped.
ALTER TABLE "WorkspaceInvitation"
    ADD CONSTRAINT "WorkspaceInvitation_invitedById_fkey"
    FOREIGN KEY ("invitedById") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "WorkspaceInvitation"
    ADD CONSTRAINT "WorkspaceInvitation_acceptedByUserId_fkey"
    FOREIGN KEY ("acceptedByUserId") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
