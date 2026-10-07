-- Phase 23: sharper reading. Additive: two nullable columns on each of the two things that read.
--
-- `imageTokens` is the share of `inputTokens` spent on the page images and `thinkingTokens` the share
-- of `outputTokens` spent thinking. Both are null on readings older than this migration.

-- AlterTable
ALTER TABLE "ExtractionRun" ADD COLUMN "imageTokens" INTEGER,
ADD COLUMN "thinkingTokens" INTEGER;

-- AlterTable
ALTER TABLE "FieldProposal" ADD COLUMN "imageTokens" INTEGER,
ADD COLUMN "thinkingTokens" INTEGER;
