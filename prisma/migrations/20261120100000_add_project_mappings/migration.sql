-- M14-01: repository-to-project mapping.
--
-- Additive only: one enum and one table, scoped by `workspaceId`. No existing row is
-- read, rewritten or deleted, so a rollback is a DROP of the table and the enum.

-- CreateEnum
CREATE TYPE "ProjectMappingSelector" AS ENUM ('PATH_PREFIX', 'BRANCH', 'LABEL', 'MILESTONE', 'REPOSITORY');

-- CreateTable
CREATE TABLE "ProjectMapping" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "repository" TEXT NOT NULL,
    "selector" "ProjectMappingSelector" NOT NULL,
    "value" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectMapping_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProjectMapping_workspaceId_projectId_idx" ON "ProjectMapping"("workspaceId", "projectId");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectMapping_workspaceId_repository_selector_value_key" ON "ProjectMapping"("workspaceId", "repository", "selector", "value");

-- AddForeignKey
ALTER TABLE "ProjectMapping" ADD CONSTRAINT "ProjectMapping_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectMapping" ADD CONSTRAINT "ProjectMapping_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

