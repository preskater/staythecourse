-- M11-03: imported AI provider usage lines (token and request counts, metadata only).
--
-- Additive only: one table. No existing row is read or rewritten.
-- Rollback: drop the table; lines are re-imported by the next synchronisation.
-- CreateTable
CREATE TABLE "AiUsageLine" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "connectionKey" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "scopeId" TEXT,
    "model" TEXT NOT NULL,
    "periodStart" TIMESTAMPTZ(3) NOT NULL,
    "periodEnd" TIMESTAMPTZ(3) NOT NULL,
    "inputTokens" BIGINT NOT NULL,
    "outputTokens" BIGINT NOT NULL,
    "requests" INTEGER,
    "dimensions" JSONB NOT NULL DEFAULT '{}',
    "fetchedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AiUsageLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiUsageLine_workspaceId_connectionKey_periodStart_idx" ON "AiUsageLine"("workspaceId", "connectionKey", "periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "AiUsageLine_workspaceId_connectionKey_externalId_key" ON "AiUsageLine"("workspaceId", "connectionKey", "externalId");

-- AddForeignKey
ALTER TABLE "AiUsageLine" ADD CONSTRAINT "AiUsageLine_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
