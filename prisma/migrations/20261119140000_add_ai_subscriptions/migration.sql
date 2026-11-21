-- M12-05: AI subscription and seat register.
--
-- Additive only: two tables, scoped through `workspaceId`. No existing row is read,
-- rewritten or deleted, so a rollback is a DROP of both tables. Renewals are booked as
-- ordinary `CostEntry` rows; the unique (subscriptionId, renewalDate) pair keeps that
-- booking re-runnable without duplicates.

-- CreateTable
CREATE TABLE "AiSubscription" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "plan" TEXT NOT NULL,
    "seats" INTEGER NOT NULL,
    "seatPrice" DECIMAL(18,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "frequency" "RecurrenceFrequency" NOT NULL DEFAULT 'MONTHLY',
    "startDate" DATE NOT NULL,
    "cancelledOn" DATE,
    "allowance" DECIMAL(18,2),
    "ownerId" TEXT,
    "allocationPolicyId" TEXT,
    "createdBy" TEXT NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AiSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiSubscriptionRenewal" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "renewalDate" DATE NOT NULL,
    "costEntryId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiSubscriptionRenewal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiSubscription_workspaceId_idx" ON "AiSubscription"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AiSubscriptionRenewal_costEntryId_key" ON "AiSubscriptionRenewal"("costEntryId");

-- CreateIndex
CREATE UNIQUE INDEX "AiSubscriptionRenewal_subscriptionId_renewalDate_key" ON "AiSubscriptionRenewal"("subscriptionId", "renewalDate");

-- AddForeignKey
ALTER TABLE "AiSubscription" ADD CONSTRAINT "AiSubscription_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiSubscription" ADD CONSTRAINT "AiSubscription_allocationPolicyId_fkey" FOREIGN KEY ("allocationPolicyId") REFERENCES "AllocationPolicy"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiSubscriptionRenewal" ADD CONSTRAINT "AiSubscriptionRenewal_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "AiSubscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiSubscriptionRenewal" ADD CONSTRAINT "AiSubscriptionRenewal_costEntryId_fkey" FOREIGN KEY ("costEntryId") REFERENCES "CostEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

