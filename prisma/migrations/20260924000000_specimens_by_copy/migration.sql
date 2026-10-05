-- Decision 78: specimens belong to the template, and go in and out of it by copy. Additive.
--
-- `Template.fieldsChangedAt` is when the part of a template a reading depends on last changed. It is
-- backfilled from `updatedAt`, so every test reading that looks stale today still does.
-- `Document.copyKey` makes a copy idempotent (a double click makes one copy); `copiedFromDocumentId`
-- is a soft reference, with no foreign key, used only to count earlier copies of a specimen.

-- AlterTable
ALTER TABLE "Template" ADD COLUMN "fieldsChangedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
UPDATE "Template" SET "fieldsChangedAt" = "updatedAt";

-- AlterTable
ALTER TABLE "Document" ADD COLUMN "copyKey" TEXT,
ADD COLUMN "copiedFromDocumentId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Document_copyKey_key" ON "Document"("copyKey");

-- CreateIndex
CREATE INDEX "Document_copiedFromDocumentId_idx" ON "Document"("copiedFromDocumentId");
