-- M10-03: client billing rates and confidential internal cost rates (micro-business).
--
-- Additive only: two new tables scoped by `workspaceId` like every other record since
-- M7-04. No existing row is read, rewritten or deleted, so a rollback is a DROP of the
-- two tables.
--
-- Both tables are effective-dated change points, the same pattern as `SalaryRate`: a
-- row applies from its month until the next row at or after it. They are deliberately
-- separate: a billing rate is what the client pays, an internal cost rate is the loaded
-- labour cost, and the two are never merged. Internal cost rates are confidential and
-- read only through the dedicated `read-internal-rates` permission.
CREATE TABLE "BillingRate" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "hourlyRate" DECIMAL(18,2) NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'EUR',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "BillingRate_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "InternalCostRate" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "hourlyRate" DECIMAL(18,2) NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'EUR',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "InternalCostRate_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BillingRate_workspaceId_clientId_year_month_idx" ON "BillingRate"("workspaceId", "clientId", "year", "month");
-- One change point per client and month; saving the same month corrects it.
CREATE UNIQUE INDEX "BillingRate_clientId_year_month_key" ON "BillingRate"("clientId", "year", "month");
CREATE UNIQUE INDEX "InternalCostRate_workspaceId_year_month_key" ON "InternalCostRate"("workspaceId", "year", "month");

ALTER TABLE "BillingRate" ADD CONSTRAINT "BillingRate_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- A client with rate history is not silently removed; archiving keeps it linked.
ALTER TABLE "BillingRate" ADD CONSTRAINT "BillingRate_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InternalCostRate" ADD CONSTRAINT "InternalCostRate_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
