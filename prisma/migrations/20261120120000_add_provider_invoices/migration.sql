-- M11-06: AI provider invoice metadata for reconciliation.
--
-- Additive only: one enum, two tables. No existing row is read or rewritten.
-- Rollback: drop both tables and the enum; invoices are typed again by hand.
-- CreateEnum
CREATE TYPE "InvoiceLineCategory" AS ENUM ('USAGE', 'CREDIT', 'DISCOUNT', 'TAX', 'FX', 'OTHER');

-- CreateTable
CREATE TABLE "ProviderInvoice" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "issuedOn" DATE NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "total" DECIMAL(18,2) NOT NULL,
    "exchangeRateSnapshotId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ProviderInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderInvoiceLine" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "category" "InvoiceLineCategory" NOT NULL,

    CONSTRAINT "ProviderInvoiceLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProviderInvoice_workspaceId_periodStart_idx" ON "ProviderInvoice"("workspaceId", "periodStart");

-- CreateIndex
CREATE INDEX "ProviderInvoice_exchangeRateSnapshotId_idx" ON "ProviderInvoice"("exchangeRateSnapshotId");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderInvoice_workspaceId_provider_number_key" ON "ProviderInvoice"("workspaceId", "provider", "number");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderInvoiceLine_invoiceId_position_key" ON "ProviderInvoiceLine"("invoiceId", "position");

-- AddForeignKey
ALTER TABLE "ProviderInvoice" ADD CONSTRAINT "ProviderInvoice_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderInvoice" ADD CONSTRAINT "ProviderInvoice_exchangeRateSnapshotId_fkey" FOREIGN KEY ("exchangeRateSnapshotId") REFERENCES "ExchangeRateSnapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderInvoiceLine" ADD CONSTRAINT "ProviderInvoiceLine_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "ProviderInvoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

