-- M10-04: estimate and scope-change versions (micro-business).
--
-- Additive only: two enums and two tables. `EstimateVersion` is scoped by
-- `workspaceId`; its items cascade with the version. No existing row is read,
-- rewritten or deleted, so a rollback is a DROP of the two tables and the enums.
--
-- A version is immutable: approval is the only transition, and approving a newer
-- version marks the project's previous approved one SUPERSEDED. Comparisons are
-- computed from the stored item rows (label + signed amount), so they are reproducible
-- without a saved snapshot.
CREATE TYPE "EstimateVersionKind" AS ENUM ('BASELINE', 'REVISION', 'CHANGE_REQUEST');
CREATE TYPE "EstimateVersionStatus" AS ENUM ('DRAFT', 'APPROVED', 'SUPERSEDED');

CREATE TABLE "EstimateVersion" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "kind" "EstimateVersionKind" NOT NULL,
    "status" "EstimateVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "currency" CHAR(3) NOT NULL,
    "assumptions" TEXT,
    "notes" TEXT,
    "approvedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "EstimateVersion_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EstimateItem" (
    "id" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "EstimateItem_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EstimateVersion_workspaceId_projectId_versionNumber_idx" ON "EstimateVersion"("workspaceId", "projectId", "versionNumber");
-- Version numbers are unique per project: the baseline is 1 and each new version is
-- the next integer, which makes the ordering stable.
CREATE UNIQUE INDEX "EstimateVersion_projectId_versionNumber_key" ON "EstimateVersion"("projectId", "versionNumber");
CREATE INDEX "EstimateItem_versionId_idx" ON "EstimateItem"("versionId");
-- A label is unique inside a version, which keeps the comparison by label unambiguous.
CREATE UNIQUE INDEX "EstimateItem_versionId_label_key" ON "EstimateItem"("versionId", "label");

ALTER TABLE "EstimateVersion" ADD CONSTRAINT "EstimateVersion_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- A project with estimate history is not silently removed.
ALTER TABLE "EstimateVersion" ADD CONSTRAINT "EstimateVersion_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EstimateItem" ADD CONSTRAINT "EstimateItem_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "EstimateVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
