-- Phase 22: credits. Additive: one new table, one column on each of the two things that spend, and
-- an index.
--
-- A CreditEntry is one line of a user's ledger (decision 81). Free credits at sign-up, a grant made
-- by hand and, later, a purchase add to it; a completed reading subtracts what it really cost. What a
-- queued or running reading is holding is `reservedMilliCredits` on the run itself, so a reading that
-- fails, is reaped or loses its document releases its hold by no longer being active.
--
-- `runId` and `proposalId` are not foreign keys: the ledger outlives deleted documents. They are
-- unique, which is what makes charging one reading twice impossible.
--
-- The Cell index is the one Phase 19's Pace queries asked for.

-- CreateEnum
CREATE TYPE "CreditKind" AS ENUM ('SIGNUP', 'GRANT', 'PURCHASE', 'USAGE');

-- CreateTable
CREATE TABLE "CreditEntry" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "CreditKind" NOT NULL,
    "milliCredits" INTEGER NOT NULL,
    "costMicroUsd" INTEGER,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "model" TEXT,
    "pages" INTEGER,
    "runId" TEXT,
    "proposalId" TEXT,
    "onceKey" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditEntry_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "ExtractionRun" ADD COLUMN "reservedMilliCredits" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "FieldProposal" ADD COLUMN "reservedMilliCredits" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE UNIQUE INDEX "CreditEntry_runId_key" ON "CreditEntry"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "CreditEntry_proposalId_key" ON "CreditEntry"("proposalId");

-- CreateIndex
CREATE UNIQUE INDEX "CreditEntry_userId_onceKey_key" ON "CreditEntry"("userId", "onceKey");

-- CreateIndex
CREATE INDEX "CreditEntry_userId_createdAt_idx" ON "CreditEntry"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "CreditEntry_kind_createdAt_idx" ON "CreditEntry"("kind", "createdAt");

-- CreateIndex
CREATE INDEX "Cell_isReviewed_reviewedAt_idx" ON "Cell"("isReviewed", "reviewedAt");

-- AddForeignKey
ALTER TABLE "CreditEntry" ADD CONSTRAINT "CreditEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
