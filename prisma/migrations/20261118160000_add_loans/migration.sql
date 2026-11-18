-- M21-01: workspace-scoped loan registry.
--
-- Additive only: two enums and one table. No existing row is read, rewritten or
-- deleted, and `PropertyLoan` is left untouched for M21-06.
--
-- A missing rate, term, insurance or balance stays NULL ("non renseigné"), never zero.
-- A null `insuranceMode` means "not recorded"; `NONE` is an explicit no-insurance.
-- Both rate columns use precision 7 so a recorded 100.0000 % (the accepted ceiling)
-- still fits.
--
-- Rollback:
--   DROP TABLE "Loan";
--   DROP TYPE "LoanInsuranceMode";
--   DROP TYPE "LoanPurpose";
CREATE TYPE "LoanPurpose" AS ENUM ('MORTGAGE', 'VEHICLE', 'CONSUMER', 'STUDENT', 'BUSINESS', 'REAL_ESTATE_INVESTMENT', 'OTHER');
CREATE TYPE "LoanInsuranceMode" AS ENUM ('NONE', 'FIXED_MONTHLY', 'RATE_OF_PRINCIPAL', 'RATE_OF_BALANCE');

CREATE TABLE "Loan" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT,
    "label" TEXT NOT NULL,
    "lender" TEXT,
    "notes" TEXT,
    "purpose" "LoanPurpose" NOT NULL DEFAULT 'OTHER',
    "currency" CHAR(3) NOT NULL DEFAULT 'EUR',
    "initialPrincipal" DECIMAL(18,2) NOT NULL,
    "annualRate" DECIMAL(7,4),
    "termMonths" INTEGER,
    "startDate" DATE,
    "firstDueDate" DATE,
    "paymentDay" INTEGER,
    "interestOnlyMonths" INTEGER NOT NULL DEFAULT 0,
    "insuranceMode" "LoanInsuranceMode",
    "insuranceMonthlyAmount" DECIMAL(18,2),
    "insuranceRate" DECIMAL(7,4),
    "fees" DECIMAL(18,2),
    "propertyId" TEXT,
    "outstandingBalance" DECIMAL(18,2),
    "balanceAsOf" DATE,
    "archivedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Loan_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Loan_workspaceId_idx" ON "Loan"("workspaceId");
CREATE INDEX "Loan_workspaceId_archivedAt_idx" ON "Loan"("workspaceId", "archivedAt");

ALTER TABLE "Loan" ADD CONSTRAINT "Loan_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Loan" ADD CONSTRAINT "Loan_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Loan" ADD CONSTRAINT "Loan_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE SET NULL ON UPDATE CASCADE;
