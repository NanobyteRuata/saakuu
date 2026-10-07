-- Phase 23: the AI_THINKING setting each reading was made at (decision 82).
-- Additive and nullable: null on readings older than this migration.

-- AlterTable
ALTER TABLE "ExtractionRun" ADD COLUMN "thinkingLevel" TEXT;

-- AlterTable
ALTER TABLE "FieldProposal" ADD COLUMN "thinkingLevel" TEXT;
