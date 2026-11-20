-- M13-03: task type and outcome taxonomy on agent runs.
--
-- Additive only: three enums and three columns. Existing runs get UNKNOWN for both
-- codes and no classification source; nothing is guessed.
-- Rollback: drop the three columns, then the three enums.
-- CreateEnum
CREATE TYPE "AgentTaskType" AS ENUM ('IMPLEMENTATION', 'TEST', 'REVIEW', 'DOCUMENTATION', 'DEBUGGING', 'ANALYSIS', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "AgentRunOutcome" AS ENUM ('ACCEPTED', 'PARTIAL', 'REJECTED', 'FAILED', 'CANCELLED', 'SUPERSEDED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "AgentClassificationSource" AS ENUM ('ADAPTER', 'MANUAL');

-- AlterTable
ALTER TABLE "AgentRun" ADD COLUMN     "classificationSource" "AgentClassificationSource",
ADD COLUMN     "outcome" "AgentRunOutcome" NOT NULL DEFAULT 'UNKNOWN',
ADD COLUMN     "taskType" "AgentTaskType" NOT NULL DEFAULT 'UNKNOWN';

