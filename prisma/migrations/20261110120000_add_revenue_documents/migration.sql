-- M10-02: revenue documents, payments, refunds and write-offs (micro-business).
--
-- Additive only: one enum and four tables, all scoped by `workspaceId` like every
-- other record since M7-04. No existing row is read, rewritten or deleted, so a
-- rollback is a DROP of the four tables and the enum.
--
-- A credit note names the invoice it reduces (`creditNoteForId`) instead of storing a
-- negative amount: the sign lives in the kind. Payment, refund and write-off rows are
-- positive magnitudes with their own date; every derived figure (paid, outstanding,
-- overdue, status) reads these rows and is never stored. Recognition is a frozen
-- snapshot: `recognizedOn` and `recognizedAmount` are set together or not at all.
CREATE TYPE "RevenueDocumentKind" AS ENUM ('INVOICE', 'CREDIT_NOTE');

CREATE TABLE "RevenueDocument" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "clientId" TEXT,
    "creditNoteForId" TEXT,
    "kind" "RevenueDocumentKind" NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "issuedOn" DATE NOT NULL,
    "dueOn" DATE,
    "recognizedOn" DATE,
    "recognizedAmount" DECIMAL(18,2),
    "notes" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "RevenueDocument_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RevenueDocument_workspaceId_issuedOn_idx" ON "RevenueDocument"("workspaceId", "issuedOn");
CREATE INDEX "RevenueDocument_workspaceId_projectId_idx" ON "RevenueDocument"("workspaceId", "projectId");
CREATE INDEX "RevenueDocument_workspaceId_kind_idx" ON "RevenueDocument"("workspaceId", "kind");

ALTER TABLE "RevenueDocument" ADD CONSTRAINT "RevenueDocument_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- A project with revenue keeps its history: the row is never silently removed.
ALTER TABLE "RevenueDocument" ADD CONSTRAINT "RevenueDocument_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RevenueDocument" ADD CONSTRAINT "RevenueDocument_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- A credit note cannot outlive the invoice it reduces.
ALTER TABLE "RevenueDocument" ADD CONSTRAINT "RevenueDocument_creditNoteForId_fkey" FOREIGN KEY ("creditNoteForId") REFERENCES "RevenueDocument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "RevenuePayment" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "paidOn" DATE NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RevenuePayment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RevenuePayment_workspaceId_paidOn_idx" ON "RevenuePayment"("workspaceId", "paidOn");
CREATE INDEX "RevenuePayment_documentId_idx" ON "RevenuePayment"("documentId");

ALTER TABLE "RevenuePayment" ADD CONSTRAINT "RevenuePayment_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RevenuePayment" ADD CONSTRAINT "RevenuePayment_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "RevenueDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "RevenueRefund" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "refundedOn" DATE NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RevenueRefund_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RevenueRefund_workspaceId_refundedOn_idx" ON "RevenueRefund"("workspaceId", "refundedOn");
CREATE INDEX "RevenueRefund_documentId_idx" ON "RevenueRefund"("documentId");

ALTER TABLE "RevenueRefund" ADD CONSTRAINT "RevenueRefund_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RevenueRefund" ADD CONSTRAINT "RevenueRefund_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "RevenueDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "RevenueWriteOff" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "writtenOffOn" DATE NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RevenueWriteOff_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RevenueWriteOff_workspaceId_writtenOffOn_idx" ON "RevenueWriteOff"("workspaceId", "writtenOffOn");
CREATE INDEX "RevenueWriteOff_documentId_idx" ON "RevenueWriteOff"("documentId");

ALTER TABLE "RevenueWriteOff" ADD CONSTRAINT "RevenueWriteOff_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RevenueWriteOff" ADD CONSTRAINT "RevenueWriteOff_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "RevenueDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;
