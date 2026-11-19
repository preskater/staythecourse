-- M9-03: versioned cost allocation policies.
--
-- Additive only: one enum, two tables and two nullable columns on "CostAllocation".
-- No existing row is read or rewritten; existing allocations keep a null policy
-- version (hand-entered). Rollback: drop the two columns, the two tables and the enum.
--
-- A policy is archived, never deleted, and a version is never updated: the
-- NO ACTION key from "CostAllocation" refuses removing a version that explains a split.
-- CreateEnum
CREATE TYPE "AllocationPolicyKind" AS ENUM ('MANUAL', 'EQUAL_SEAT', 'USAGE_WEIGHTED', 'REVENUE_WEIGHTED', 'FIXED_PERCENTAGE');

-- AlterTable
ALTER TABLE "CostAllocation" ADD COLUMN     "policyMeasure" DECIMAL(30,10),
ADD COLUMN     "policyVersionId" TEXT;

-- CreateTable
CREATE TABLE "AllocationPolicy" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "AllocationPolicyKind" NOT NULL,
    "archivedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AllocationPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AllocationPolicyVersion" (
    "id" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "rationale" TEXT NOT NULL,
    "targets" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AllocationPolicyVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AllocationPolicy_workspaceId_name_key" ON "AllocationPolicy"("workspaceId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "AllocationPolicyVersion_policyId_version_key" ON "AllocationPolicyVersion"("policyId", "version");

-- CreateIndex
CREATE INDEX "CostAllocation_policyVersionId_idx" ON "CostAllocation"("policyVersionId");

-- AddForeignKey
ALTER TABLE "CostAllocation" ADD CONSTRAINT "CostAllocation_policyVersionId_fkey" FOREIGN KEY ("policyVersionId") REFERENCES "AllocationPolicyVersion"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AllocationPolicy" ADD CONSTRAINT "AllocationPolicy_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AllocationPolicyVersion" ADD CONSTRAINT "AllocationPolicyVersion_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "AllocationPolicy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

