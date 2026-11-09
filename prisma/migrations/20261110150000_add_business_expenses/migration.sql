-- M10-05: recurring business expenses and obligations (micro-business).
--
-- Additive only: one enum and one table, scoped by `workspaceId`. No existing row is
-- read, rewritten or deleted, so a rollback is a DROP of the table and the enum.
--
-- The definition never writes to the ledger. Occurrences are computed from the cadence
-- and the start date on read (the budget module's day-of-month and cadence rules), so
-- re-running the computation cannot create a duplicate. `RESERVE` is a planning
-- envelope: every amount is an estimate, never a payment or tax advice.
CREATE TYPE "BusinessExpenseKind" AS ENUM ('EXPENSE', 'OBLIGATION', 'RESERVE');

CREATE TABLE "BusinessExpense" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "vendor" TEXT,
    "kind" "BusinessExpenseKind" NOT NULL DEFAULT 'EXPENSE',
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'EUR',
    "frequency" "RecurrenceFrequency" NOT NULL DEFAULT 'MONTHLY',
    "startDate" DATE NOT NULL,
    "endDate" DATE,
    "notes" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "BusinessExpense_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BusinessExpense_workspaceId_startDate_idx" ON "BusinessExpense"("workspaceId", "startDate");

ALTER TABLE "BusinessExpense" ADD CONSTRAINT "BusinessExpense_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
