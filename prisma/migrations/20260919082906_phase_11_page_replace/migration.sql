-- Phase 11: re-shooting a page. Additive and nullable throughout, so no backfill is needed:
-- contentChangedAt NULL means nothing has changed since the document was last read.
-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "contentChangedAt" TIMESTAMPTZ(3),
ADD COLUMN     "lastExtractedAt" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "Photo" ADD COLUMN     "deletedAt" TIMESTAMPTZ(3),
ADD COLUMN     "replacedAt" TIMESTAMPTZ(3),
ADD COLUMN     "replacesPhotoId" TEXT,
ADD COLUMN     "transformedAt" TIMESTAMPTZ(3);

-- CreateIndex
CREATE INDEX "Photo_documentId_deletedAt_idx" ON "Photo"("documentId", "deletedAt");

-- CreateIndex
CREATE INDEX "Photo_replacesPhotoId_idx" ON "Photo"("replacesPhotoId");
