-- M11-05: stored AI provider credentials, encrypted at rest.
--
-- Additive only: one enum and one table, separate from "IntegrationConnection" (read as
-- GitHub/GitLab connections by the sync job, the dashboard, alerts, diagnostics and
-- search, and guarded by another module). No existing row is read or rewritten.
-- The table holds ciphertext only; a revoked row has NULL ciphertext.
-- Rollback: drop the table and the enum; credentials must then be entered again.
-- CreateEnum
CREATE TYPE "AiConnectionStatus" AS ENUM ('VALID', 'INVALID', 'REVOKED');

-- CreateTable
CREATE TABLE "AiProviderConnection" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "instanceUrl" TEXT NOT NULL DEFAULT '',
    "credentialsCiphertext" TEXT,
    "accountLabel" TEXT,
    "grantedScopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "scopesReported" BOOLEAN NOT NULL DEFAULT false,
    "status" "AiConnectionStatus" NOT NULL DEFAULT 'VALID',
    "lastValidatedAt" TIMESTAMPTZ(3),
    "lastValidationError" TEXT,
    "credentialUpdatedAt" TIMESTAMPTZ(3) NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AiProviderConnection_pkey" PRIMARY KEY ("id"),
    -- A revoked connection never keeps a secret.
    CONSTRAINT "AiProviderConnection_revoked_has_no_secret" CHECK ("status" <> 'REVOKED' OR "credentialsCiphertext" IS NULL)
);

-- CreateIndex
CREATE UNIQUE INDEX "AiProviderConnection_workspaceId_provider_instanceUrl_key" ON "AiProviderConnection"("workspaceId", "provider", "instanceUrl");

-- AddForeignKey
ALTER TABLE "AiProviderConnection" ADD CONSTRAINT "AiProviderConnection_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
