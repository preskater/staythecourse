-- M14-02: GitHub delivery history (pull requests and their files, reviews, commits and
-- closing issue links; releases; deployments).
--
-- Additive only: seven new tables, all cascading from "IntegrationConnection". No
-- existing row is read or rewritten. Metadata only: no description, comment text,
-- commit message or diff is stored. Retention: 13 months on the provider's update or
-- creation instant, applied by `npm run db:cleanup`.
-- Rollback: drop the seven tables.
-- CreateTable
CREATE TABLE "PullRequestSnapshot" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "provider" "IntegrationProvider" NOT NULL,
    "externalId" TEXT NOT NULL,
    "repository" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "authorLogin" TEXT,
    "state" TEXT NOT NULL,
    "isDraft" BOOLEAN NOT NULL,
    "baseBranch" TEXT NOT NULL,
    "headBranch" TEXT NOT NULL,
    "additions" INTEGER NOT NULL,
    "deletions" INTEGER NOT NULL,
    "changedFiles" INTEGER NOT NULL,
    "commitsCount" INTEGER NOT NULL,
    "commentsCount" INTEGER NOT NULL,
    "reviewsCount" INTEGER NOT NULL,
    "openedAt" TIMESTAMPTZ(3) NOT NULL,
    "closedAt" TIMESTAMPTZ(3),
    "mergedAt" TIMESTAMPTZ(3),
    "firstReviewAt" TIMESTAMPTZ(3),
    "providerUpdatedAt" TIMESTAMPTZ(3) NOT NULL,
    "childrenTruncated" BOOLEAN NOT NULL DEFAULT false,
    "fetchedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "PullRequestSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PullRequestFile" (
    "id" TEXT NOT NULL,
    "pullRequestId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "additions" INTEGER NOT NULL,
    "deletions" INTEGER NOT NULL,
    "changeType" TEXT NOT NULL,

    CONSTRAINT "PullRequestFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PullRequestReview" (
    "id" TEXT NOT NULL,
    "pullRequestId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "authorLogin" TEXT,
    "state" TEXT NOT NULL,
    "submittedAt" TIMESTAMPTZ(3),

    CONSTRAINT "PullRequestReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PullRequestCommit" (
    "id" TEXT NOT NULL,
    "pullRequestId" TEXT NOT NULL,
    "sha" TEXT NOT NULL,
    "authorLogin" TEXT,
    "committedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "PullRequestCommit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PullRequestIssueLink" (
    "id" TEXT NOT NULL,
    "pullRequestId" TEXT NOT NULL,
    "repository" TEXT NOT NULL,
    "issueNumber" INTEGER NOT NULL,
    "url" TEXT NOT NULL,

    CONSTRAINT "PullRequestIssueLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReleaseSnapshot" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "provider" "IntegrationProvider" NOT NULL,
    "externalId" TEXT NOT NULL,
    "repository" TEXT NOT NULL,
    "tagName" TEXT NOT NULL,
    "name" TEXT,
    "url" TEXT NOT NULL,
    "isPrerelease" BOOLEAN NOT NULL,
    "isDraft" BOOLEAN NOT NULL,
    "releasedAt" TIMESTAMPTZ(3) NOT NULL,
    "publishedAt" TIMESTAMPTZ(3),
    "fetchedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ReleaseSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeploymentSnapshot" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "provider" "IntegrationProvider" NOT NULL,
    "externalId" TEXT NOT NULL,
    "repository" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "sha" TEXT NOT NULL,
    "state" TEXT,
    "deployedAt" TIMESTAMPTZ(3) NOT NULL,
    "statusUpdatedAt" TIMESTAMPTZ(3),
    "fetchedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "DeploymentSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PullRequestSnapshot_connectionId_repository_number_idx" ON "PullRequestSnapshot"("connectionId", "repository", "number");

-- CreateIndex
CREATE INDEX "PullRequestSnapshot_connectionId_mergedAt_idx" ON "PullRequestSnapshot"("connectionId", "mergedAt");

-- CreateIndex
CREATE INDEX "PullRequestSnapshot_connectionId_providerUpdatedAt_idx" ON "PullRequestSnapshot"("connectionId", "providerUpdatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PullRequestSnapshot_connectionId_externalId_key" ON "PullRequestSnapshot"("connectionId", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "PullRequestFile_pullRequestId_path_key" ON "PullRequestFile"("pullRequestId", "path");

-- CreateIndex
CREATE UNIQUE INDEX "PullRequestReview_pullRequestId_externalId_key" ON "PullRequestReview"("pullRequestId", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "PullRequestCommit_pullRequestId_sha_key" ON "PullRequestCommit"("pullRequestId", "sha");

-- CreateIndex
CREATE UNIQUE INDEX "PullRequestIssueLink_pullRequestId_repository_issueNumber_key" ON "PullRequestIssueLink"("pullRequestId", "repository", "issueNumber");

-- CreateIndex
CREATE INDEX "ReleaseSnapshot_connectionId_repository_releasedAt_idx" ON "ReleaseSnapshot"("connectionId", "repository", "releasedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReleaseSnapshot_connectionId_externalId_key" ON "ReleaseSnapshot"("connectionId", "externalId");

-- CreateIndex
CREATE INDEX "DeploymentSnapshot_connectionId_repository_deployedAt_idx" ON "DeploymentSnapshot"("connectionId", "repository", "deployedAt");

-- CreateIndex
CREATE UNIQUE INDEX "DeploymentSnapshot_connectionId_externalId_key" ON "DeploymentSnapshot"("connectionId", "externalId");

-- AddForeignKey
ALTER TABLE "PullRequestSnapshot" ADD CONSTRAINT "PullRequestSnapshot_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "IntegrationConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PullRequestFile" ADD CONSTRAINT "PullRequestFile_pullRequestId_fkey" FOREIGN KEY ("pullRequestId") REFERENCES "PullRequestSnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PullRequestReview" ADD CONSTRAINT "PullRequestReview_pullRequestId_fkey" FOREIGN KEY ("pullRequestId") REFERENCES "PullRequestSnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PullRequestCommit" ADD CONSTRAINT "PullRequestCommit_pullRequestId_fkey" FOREIGN KEY ("pullRequestId") REFERENCES "PullRequestSnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PullRequestIssueLink" ADD CONSTRAINT "PullRequestIssueLink_pullRequestId_fkey" FOREIGN KEY ("pullRequestId") REFERENCES "PullRequestSnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReleaseSnapshot" ADD CONSTRAINT "ReleaseSnapshot_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "IntegrationConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeploymentSnapshot" ADD CONSTRAINT "DeploymentSnapshot_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "IntegrationConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

