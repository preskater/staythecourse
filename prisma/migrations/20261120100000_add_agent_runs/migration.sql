-- M13-02: agent runs and their links to cost entries.
--
-- Additive only: one enum and two tables. No existing row is read or rewritten.
-- Rollback: drop "AgentRunCost", then "AgentRun", then the enum.
-- CreateEnum
CREATE TYPE "AgentRunResult" AS ENUM ('SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "AgentRun" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "agentVersionId" TEXT NOT NULL,
    "externalRef" TEXT NOT NULL,
    "traceId" TEXT,
    "startedAt" TIMESTAMPTZ(3),
    "endedAt" TIMESTAMPTZ(3),
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "retries" INTEGER,
    "toolCalls" INTEGER,
    "result" "AgentRunResult",
    "initiator" TEXT,
    "deliveryLinks" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AgentRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentRunCost" (
    "runId" TEXT NOT NULL,
    "costEntryId" TEXT NOT NULL,

    CONSTRAINT "AgentRunCost_pkey" PRIMARY KEY ("runId","costEntryId")
);

-- CreateIndex
CREATE INDEX "AgentRun_agentVersionId_idx" ON "AgentRun"("agentVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentRun_workspaceId_externalRef_key" ON "AgentRun"("workspaceId", "externalRef");

-- CreateIndex
CREATE INDEX "AgentRunCost_costEntryId_idx" ON "AgentRunCost"("costEntryId");

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_agentVersionId_fkey" FOREIGN KEY ("agentVersionId") REFERENCES "AgentVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRunCost" ADD CONSTRAINT "AgentRunCost_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRunCost" ADD CONSTRAINT "AgentRunCost_costEntryId_fkey" FOREIGN KEY ("costEntryId") REFERENCES "CostEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

