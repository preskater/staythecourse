-- M12-03: AI budgets and spend alerts.
--
-- Additive only: two alert kinds and one table, scoped by `workspaceId`. No existing
-- row is read, rewritten or deleted, so a rollback is a DROP of the table (enum values
-- cannot be dropped in PostgreSQL; unused, they are harmless).
ALTER TYPE "AlertKind" ADD VALUE 'AI_BUDGET_OVERRUN';
ALTER TYPE "AlertKind" ADD VALUE 'AI_BUDGET_THRESHOLD';

CREATE TABLE "AiBudget" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "dimension" TEXT NOT NULL,
    "dimensionValue" TEXT NOT NULL DEFAULT '',
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AiBudget_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AiBudget_workspaceId_dimension_dimensionValue_currency_key" ON "AiBudget"("workspaceId", "dimension", "dimensionValue", "currency");

ALTER TABLE "AiBudget" ADD CONSTRAINT "AiBudget_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
