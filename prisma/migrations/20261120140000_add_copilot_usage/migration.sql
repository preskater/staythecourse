-- M11-08: GitHub Copilot seat snapshots and organization activity days.
--
-- Additive only: two tables. No existing row is read or rewritten.
-- Rollback: drop both tables; the next synchronisation reads them again from GitHub.
-- CreateTable
CREATE TABLE "CopilotSeatSnapshot" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "connectionKey" TEXT NOT NULL,
    "organization" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "planType" TEXT,
    "total" INTEGER NOT NULL,
    "activeThisCycle" INTEGER NOT NULL,
    "inactiveThisCycle" INTEGER NOT NULL,
    "addedThisCycle" INTEGER NOT NULL,
    "pendingInvitation" INTEGER NOT NULL,
    "pendingCancellation" INTEGER NOT NULL,
    "listedSeats" INTEGER,
    "fetchedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CopilotSeatSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CopilotUsageDay" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "connectionKey" TEXT NOT NULL,
    "organization" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "dailyActiveUsers" INTEGER NOT NULL,
    "weeklyActiveUsers" INTEGER,
    "monthlyActiveUsers" INTEGER,
    "monthlyActiveAgentUsers" INTEGER,
    "dailyActiveCloudAgentUsers" INTEGER,
    "interactionCount" INTEGER,
    "codeGenerationCount" INTEGER,
    "codeAcceptanceCount" INTEGER,
    "thirdPartyAgents" JSONB NOT NULL DEFAULT '[]',
    "fetchedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CopilotUsageDay_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CopilotSeatSnapshot_workspaceId_connectionKey_organization__key" ON "CopilotSeatSnapshot"("workspaceId", "connectionKey", "organization", "day");

-- CreateIndex
CREATE INDEX "CopilotUsageDay_workspaceId_day_idx" ON "CopilotUsageDay"("workspaceId", "day");

-- CreateIndex
CREATE UNIQUE INDEX "CopilotUsageDay_workspaceId_connectionKey_organization_day_key" ON "CopilotUsageDay"("workspaceId", "connectionKey", "organization", "day");

-- AddForeignKey
ALTER TABLE "CopilotSeatSnapshot" ADD CONSTRAINT "CopilotSeatSnapshot_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CopilotUsageDay" ADD CONSTRAINT "CopilotUsageDay_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

