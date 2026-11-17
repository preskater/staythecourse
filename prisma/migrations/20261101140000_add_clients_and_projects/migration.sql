-- M10-01: clients and projects (micro-business).
--
-- Additive only: two new enums and two new tables, both scoped by `workspaceId` like
-- every other record since M7-04. No existing row is read, rewritten or deleted, so a
-- rollback is a simple DROP of the two tables.
--
-- Archiving is a `archivedAt` stamp rather than a status: an archived client or project
-- keeps every field, and restoring only clears the stamp. `Project.billingModel` is an
-- enum so later revenue entries can branch on it instead of parsing free text.
CREATE TYPE "BillingModel" AS ENUM ('FIXED_PRICE', 'TIME_AND_MATERIALS', 'RETAINER', 'INTERNAL', 'NON_BILLABLE');
CREATE TYPE "ProjectStatus" AS ENUM ('ACTIVE', 'COMPLETED');

CREATE TABLE "Client" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contactName" TEXT,
    "email" TEXT,
    "notes" TEXT,
    "archivedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Client_pkey" PRIMARY KEY ("id")
);

-- A name is unique per workspace, archived rows included: two clients can never be
-- confused, and a restore never collides with a newer row.
CREATE UNIQUE INDEX "Client_workspaceId_name_key" ON "Client"("workspaceId", "name");
CREATE INDEX "Client_workspaceId_idx" ON "Client"("workspaceId");

ALTER TABLE "Client" ADD CONSTRAINT "Client_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "clientId" TEXT,
    "name" TEXT NOT NULL,
    "billingModel" "BillingModel" NOT NULL,
    "status" "ProjectStatus" NOT NULL DEFAULT 'ACTIVE',
    "currency" CHAR(3) NOT NULL DEFAULT 'EUR',
    "startDate" DATE,
    "endDate" DATE,
    "notes" TEXT,
    "archivedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Project_workspaceId_name_key" ON "Project"("workspaceId", "name");
CREATE INDEX "Project_workspaceId_idx" ON "Project"("workspaceId");
CREATE INDEX "Project_workspaceId_clientId_idx" ON "Project"("workspaceId", "clientId");

ALTER TABLE "Project" ADD CONSTRAINT "Project_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- A removed client leaves its projects unlinked rather than deleting them; archiving a
-- client keeps the link untouched.
ALTER TABLE "Project" ADD CONSTRAINT "Project_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;
