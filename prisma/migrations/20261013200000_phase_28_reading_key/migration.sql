-- Phase 28: fields changed since read (decisions 88 and 89).
--
-- `Template.readingKey` is the fingerprint of what the AI is told about a template. It cannot be
-- computed in SQL, so it starts empty and is taken the first time the template is edited or read
-- (`lockTemplate`, `lib/templates/access.ts`).
-- `Document.readWithKey` is the fingerprint a document's reading was made under. Every document read
-- before this migration gets the placeholder `start`, which is swapped for its template's real
-- fingerprint at that same moment. So existing readings start clean: nothing is flagged until a
-- template really changes.
-- `ExtractionRun.readingKey` is what one run was really sent. Older runs have none.
--
-- `Template.fieldsChangedAt` stays, unread and unwritten, so the previous image still runs.

ALTER TABLE "Template" ADD COLUMN "readingKey" TEXT;
ALTER TABLE "Document" ADD COLUMN "readWithKey" TEXT;
ALTER TABLE "ExtractionRun" ADD COLUMN "readingKey" TEXT;

UPDATE "Document" SET "readWithKey" = 'start' WHERE "lastExtractedAt" IS NOT NULL;
