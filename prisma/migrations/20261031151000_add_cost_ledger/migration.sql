-- M9-02: canonical cost ledger (CostEntry + CostAllocation).
--
-- Additive only: two new tables, three enums, their indexes and foreign keys.
-- There is nothing to backfill — no earlier table held a cost entry. `CostAllocation`
-- is a child of `CostEntry` and deliberately carries no `workspaceId` of its own:
-- it is reachable only through its entry, which cascades with the workspace
-- (same rule as the other child tables in `20261023100000_scope_records_by_workspace`).
--
-- The check constraints make the invariants hold even for a direct SQL write:
-- an entry or allocation is never zero, a period never ends before it starts, and
-- a source reference has exactly the columns its kind requires. Allocation
-- conservation (`allocated + unallocated = entry total`) needs the other rows, so
-- it is enforced by `src/modules/ai-costs/repository.ts` inside a transaction that
-- locks the entry row.

-- CreateEnum
CREATE TYPE "CostActuality" AS ENUM ('OBSERVED', 'DERIVED', 'ALLOCATED', 'ESTIMATED', 'RECONCILED');

-- CreateEnum
CREATE TYPE "CostSourceKind" AS ENUM ('PROVIDER', 'IMPORT', 'MANUAL');

-- CreateEnum
CREATE TYPE "CostEntryStatus" AS ENUM ('DRAFT', 'FINALIZED');

-- CreateTable
CREATE TABLE "CostEntry" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'EUR',
    "actuality" "CostActuality" NOT NULL,
    "sourceKind" "CostSourceKind" NOT NULL,
    "sourceProvider" TEXT,
    "sourceExternalId" TEXT,
    "sourceImportId" TEXT,
    "sourceRowNumber" INTEGER,
    "sourceEnteredBy" TEXT,
    "sourceCapturedAt" TIMESTAMPTZ(3) NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "notes" TEXT,
    "projectId" TEXT,
    "clientId" TEXT,
    "repository" TEXT,
    "developerId" TEXT,
    "agentId" TEXT,
    "issueId" TEXT,
    "pullRequestId" TEXT,
    "environment" TEXT,
    "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "status" "CostEntryStatus" NOT NULL DEFAULT 'DRAFT',
    "finalizedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CostEntry_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CostEntry_amount_not_zero_check" CHECK ("amount" <> 0),
    CONSTRAINT "CostEntry_period_order_check" CHECK ("periodEnd" >= "periodStart"),
    CONSTRAINT "CostEntry_source_shape_check" CHECK (
        ("sourceKind" = 'PROVIDER'
            AND "sourceProvider" IS NOT NULL
            AND "sourceExternalId" IS NOT NULL
            AND "sourceImportId" IS NULL
            AND "sourceRowNumber" IS NULL
            AND "sourceEnteredBy" IS NULL)
        OR ("sourceKind" = 'IMPORT'
            AND "sourceProvider" IS NULL
            AND "sourceExternalId" IS NULL
            AND "sourceImportId" IS NOT NULL
            AND "sourceRowNumber" IS NOT NULL
            AND "sourceEnteredBy" IS NULL)
        OR ("sourceKind" = 'MANUAL'
            AND "sourceProvider" IS NULL
            AND "sourceExternalId" IS NULL
            AND "sourceImportId" IS NULL
            AND "sourceRowNumber" IS NULL
            AND "sourceEnteredBy" IS NOT NULL)
    )
);

-- CreateTable
CREATE TABLE "CostAllocation" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "projectId" TEXT,
    "clientId" TEXT,
    "repository" TEXT,
    "developerId" TEXT,
    "agentId" TEXT,
    "issueId" TEXT,
    "pullRequestId" TEXT,
    "environment" TEXT,
    "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CostAllocation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CostAllocation_amount_not_zero_check" CHECK ("amount" <> 0)
);

-- CreateIndex
CREATE INDEX "CostEntry_workspaceId_periodStart_idx" ON "CostEntry"("workspaceId", "periodStart");

-- CreateIndex
CREATE INDEX "CostEntry_workspaceId_status_idx" ON "CostEntry"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "CostEntry_workspaceId_projectId_idx" ON "CostEntry"("workspaceId", "projectId");

-- CreateIndex
CREATE INDEX "CostEntry_workspaceId_clientId_idx" ON "CostEntry"("workspaceId", "clientId");

-- CreateIndex
CREATE INDEX "CostEntry_workspaceId_repository_idx" ON "CostEntry"("workspaceId", "repository");

-- CreateIndex
CREATE INDEX "CostAllocation_entryId_idx" ON "CostAllocation"("entryId");

-- CreateIndex
CREATE INDEX "CostAllocation_projectId_idx" ON "CostAllocation"("projectId");

-- CreateIndex
CREATE INDEX "CostAllocation_clientId_idx" ON "CostAllocation"("clientId");

-- CreateIndex
CREATE INDEX "CostAllocation_repository_idx" ON "CostAllocation"("repository");

-- AddForeignKey
ALTER TABLE "CostEntry" ADD CONSTRAINT "CostEntry_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CostAllocation" ADD CONSTRAINT "CostAllocation_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "CostEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;
