-- M11-02: imported AI provider cost lines.
--
-- Additive only: one table. No existing row is read or rewritten.
-- Rollback: drop the table; lines are re-imported by the next synchronisation.
-- CreateTable
CREATE TABLE "AiCostLine" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "connectionKey" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "scopeId" TEXT,
    "model" TEXT,
    "periodStart" TIMESTAMPTZ(3) NOT NULL,
    "periodEnd" TIMESTAMPTZ(3) NOT NULL,
    "amount" DECIMAL(24,10) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "dimensions" JSONB NOT NULL DEFAULT '{}',
    "fetchedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AiCostLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiCostLine_workspaceId_connectionKey_periodStart_idx" ON "AiCostLine"("workspaceId", "connectionKey", "periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "AiCostLine_workspaceId_connectionKey_externalId_key" ON "AiCostLine"("workspaceId", "connectionKey", "externalId");

-- AddForeignKey
ALTER TABLE "AiCostLine" ADD CONSTRAINT "AiCostLine_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

