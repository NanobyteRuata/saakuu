-- Phase 12: before strangers. Additive and nullable throughout, so no backfill is needed.
-- User.aiApiKeyCipher holds this user's own Gemini key, encrypted at rest by lib/crypto; aiApiKeyHint
-- is its last four characters, which is all the UI ever shows (decision 54).
-- Cell.reviewedAt/reviewedVia record when a cell became reviewed and how, because a row-level mark
-- stamps every cell of the row at one instant and an average that mixes the two is fiction
-- (decisions 56, 57). Cells reviewed before this migration simply have no timing.
-- CreateEnum
CREATE TYPE "ReviewSource" AS ENUM ('CELL', 'ROW', 'ILLEGIBLE');

-- AlterTable
ALTER TABLE "Cell" ADD COLUMN     "reviewedAt" TIMESTAMPTZ(3),
ADD COLUMN     "reviewedVia" "ReviewSource";

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "aiApiKeyCipher" TEXT,
ADD COLUMN     "aiApiKeyHint" TEXT;

