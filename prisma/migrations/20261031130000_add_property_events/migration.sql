-- RE-04: property events and due dates.
--
-- An event is a reminder, not a financial entry. `amount` is informational only and
-- never feeds the property totals; only a transaction or a cashflow entry moves money.
-- `dueDate` is a calendar day (DATE), and NULL deliberately means "no date recorded":
-- such an event is never considered overdue.
--
-- Ownership is scoped through the property (the table carries no `workspaceId`), like
-- `PropertyCashflow` and `PropertyLoan`, and deleting the property cascades.

-- CreateEnum
CREATE TYPE "PropertyEventKind" AS ENUM ('TAX', 'INSURANCE', 'MAINTENANCE', 'LEASE', 'INSPECTION', 'LOAN', 'RENOVATION', 'OTHER');

-- CreateEnum
CREATE TYPE "PropertyEventStatus" AS ENUM ('PLANNED', 'DONE', 'CANCELLED');

-- CreateTable
CREATE TABLE "PropertyEvent" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "kind" "PropertyEventKind" NOT NULL,
    "label" TEXT NOT NULL,
    "dueDate" DATE,
    "status" "PropertyEventStatus" NOT NULL DEFAULT 'PLANNED',
    "amount" DECIMAL(18,2),
    "currency" CHAR(3),
    "notes" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "PropertyEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PropertyEvent_propertyId_dueDate_idx" ON "PropertyEvent"("propertyId", "dueDate");

-- CreateIndex
CREATE INDEX "PropertyEvent_propertyId_status_idx" ON "PropertyEvent"("propertyId", "status");

-- AddForeignKey
ALTER TABLE "PropertyEvent" ADD CONSTRAINT "PropertyEvent_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE;
