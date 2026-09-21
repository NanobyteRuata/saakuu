-- Phase 15: the paper on screen. Additive with a default, so no backfill: every existing document
-- is an ordinary document, which is what false means.
--
-- Document.isSpecimen marks a page uploaded to build a template against (decision 71). A specimen is
-- a real Document — same upload, same processing, same extraction, same raw layer — rather than a
-- separate object, because a separate one would make the operator upload the same page twice for
-- reasons they cannot be told, and would have been a fourth photo-intake UI. Its rows are still
-- built, so clearing the flag promotes it in one click with no re-extraction and no retransform.
--
-- The rule the read paths apply: a specimen is excluded wherever the number means "work to do" (the
-- output table, the export, review progress, the template's document count, Extract all) and stays
-- visible wherever the number means "files I have" (the Documents list), which is where the promote
-- action lives.

-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "isSpecimen" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "Document_templateId_isSpecimen_idx" ON "Document"("templateId", "isSpecimen");
