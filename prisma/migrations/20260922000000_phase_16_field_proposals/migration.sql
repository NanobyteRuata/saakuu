-- Phase 16: the AI proposes the template. Additive: one new table, nothing existing changes.
--
-- A FieldProposal is one AI reading of a specimen that lists the template's fields (flat fields only,
-- decision 73). It is a proposal, not a write: its items are shown with per-field toggles and a
-- counted confirmation, and nothing reaches the template until the operator confirms. It records
-- `promptVersion` as every extraction run does, and its token counts, because it costs money.
--
-- It is not an ExtractionRun: every run of a document is read as an extraction — its run state, its
-- raw layer — and a proposal is neither. Cascades with its template and its specimen document.

-- CreateTable
CREATE TABLE "FieldProposal" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "photoIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "model" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "state" "RunState" NOT NULL DEFAULT 'QUEUED',
    "startedAt" TIMESTAMPTZ(3),
    "finishedAt" TIMESTAMPTZ(3),
    "error" TEXT,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "rawResponse" JSONB,
    "items" JSONB,
    "acceptedAt" TIMESTAMPTZ(3),
    "acceptedFieldIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FieldProposal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FieldProposal_idempotencyKey_key" ON "FieldProposal"("idempotencyKey");

-- CreateIndex
CREATE INDEX "FieldProposal_templateId_createdAt_idx" ON "FieldProposal"("templateId", "createdAt");

-- CreateIndex
CREATE INDEX "FieldProposal_documentId_idx" ON "FieldProposal"("documentId");

-- CreateIndex
CREATE INDEX "FieldProposal_state_idx" ON "FieldProposal"("state");

-- AddForeignKey
ALTER TABLE "FieldProposal" ADD CONSTRAINT "FieldProposal_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "Template"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FieldProposal" ADD CONSTRAINT "FieldProposal_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

