-- M9-05: CSV cost import.
--
-- Additive only: one nullable column and a unique index on "CostEntry", and one
-- mapping table. Existing entries keep a null "importKey"; PostgreSQL lets any number
-- of NULLs coexist under the unique index, so nothing existing can conflict.
-- Rollback: drop the table, the index and the column.
-- AlterTable
ALTER TABLE "CostEntry" ADD COLUMN     "importKey" TEXT;

-- CreateTable
CREATE TABLE "CostImportMapping" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "delimiter" TEXT NOT NULL,
    "hasHeader" BOOLEAN NOT NULL DEFAULT true,
    "columns" JSONB NOT NULL,
    "defaultCurrency" CHAR(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CostImportMapping_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CostImportMapping_workspaceId_source_key" ON "CostImportMapping"("workspaceId", "source");

-- CreateIndex
CREATE UNIQUE INDEX "CostEntry_workspaceId_importKey_key" ON "CostEntry"("workspaceId", "importKey");

-- AddForeignKey
ALTER TABLE "CostImportMapping" ADD CONSTRAINT "CostImportMapping_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

