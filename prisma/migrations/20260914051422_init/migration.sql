-- CreateEnum
CREATE TYPE "NumeralSystem" AS ENUM ('AUTO', 'LATIN', 'MYANMAR');

-- CreateEnum
CREATE TYPE "DateEra" AS ENUM ('GREGORIAN', 'BUDDHIST', 'MYANMAR');

-- CreateEnum
CREATE TYPE "ColumnType" AS ENUM ('TEXT', 'NUMBER', 'INTEGER', 'DATE', 'BOOLEAN', 'ENUM');

-- CreateEnum
CREATE TYPE "TemplateKind" AS ENUM ('FORM', 'TABLE');

-- CreateEnum
CREATE TYPE "ConfigState" AS ENUM ('DRAFT', 'READY', 'CONFLICTED');

-- CreateEnum
CREATE TYPE "FieldType" AS ENUM ('TEXT', 'NUMBER', 'INTEGER', 'DATE', 'MARK', 'CHOICE', 'AGE', 'FRACTION');

-- CreateEnum
CREATE TYPE "FieldMode" AS ENUM ('EXTRACT', 'SKIP', 'MANUAL');

-- CreateEnum
CREATE TYPE "MappingKind" AS ENUM ('COPY', 'CONCAT', 'SPLIT', 'CONSTANT', 'EXPRESSION');

-- CreateEnum
CREATE TYPE "MappingState" AS ENUM ('OK', 'BROKEN');

-- CreateEnum
CREATE TYPE "RunState" AS ENUM ('NEVER_RUN', 'QUEUED', 'RUNNING', 'PARTIAL', 'FAILED', 'COMPLETE');

-- CreateEnum
CREATE TYPE "ContentState" AS ENUM ('UNKNOWN', 'HAS_CONTENT', 'EMPTY', 'NO_ROWS_FOUND');

-- CreateEnum
CREATE TYPE "PhotoStatus" AS ENUM ('DRAFT', 'QUEUED', 'PROCESSING', 'FAILED', 'DONE');

-- CreateEnum
CREATE TYPE "RowType" AS ENUM ('DATA', 'HEADER', 'SUBTOTAL', 'TOTAL', 'NOTE');

-- CreateEnum
CREATE TYPE "ValueState" AS ENUM ('OK', 'ILLEGIBLE', 'EMPTY', 'DASH', 'NOT_APPLICABLE');

-- CreateEnum
CREATE TYPE "ValidationState" AS ENUM ('NONE', 'WARNING', 'ERROR');

-- CreateEnum
CREATE TYPE "RuleKind" AS ENUM ('REQUIRED', 'TYPE', 'RANGE', 'LENGTH', 'REGEX', 'ENUM', 'UNIQUE', 'CROSS_COLUMN', 'MONOTONIC');

-- CreateEnum
CREATE TYPE "RuleSeverity" AS ENUM ('WARNING', 'ERROR');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerified" TIMESTAMPTZ(3),
    "name" TEXT,
    "image" TEXT,
    "passwordHash" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "refresh_token" TEXT,
    "access_token" TEXT,
    "expires_at" INTEGER,
    "token_type" TEXT,
    "scope" TEXT,
    "id_token" TEXT,
    "session_state" TEXT,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "sessionToken" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expires" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationToken" (
    "identifier" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires" TIMESTAMPTZ(3) NOT NULL,
    "purpose" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "Book" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "defaultModel" TEXT NOT NULL DEFAULT 'gemini-2.5-flash',
    "numeralSystem" "NumeralSystem" NOT NULL DEFAULT 'AUTO',
    "dateEra" "DateEra" NOT NULL DEFAULT 'GREGORIAN',
    "blankToken" TEXT NOT NULL DEFAULT '',
    "illegibleToken" TEXT NOT NULL DEFAULT '?',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Book_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutputColumn" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "dataType" "ColumnType" NOT NULL DEFAULT 'TEXT',
    "enumValues" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "position" TEXT NOT NULL,
    "isRequired" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "OutputColumn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GlossaryEntry" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "term" TEXT NOT NULL,
    "meaning" TEXT NOT NULL,
    "position" TEXT NOT NULL,

    CONSTRAINT "GlossaryEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Template" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "TemplateKind" NOT NULL,
    "configState" "ConfigState" NOT NULL DEFAULT 'DRAFT',
    "modelOverride" TEXT,
    "doubleExtraction" BOOLEAN NOT NULL DEFAULT false,
    "anchors" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "languageHint" TEXT,
    "instructions" TEXT,
    "sequenceFieldId" TEXT,
    "position" TEXT NOT NULL,
    "sourceDefId" TEXT,
    "sourceDefVersion" INTEGER,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Template_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FieldGroup" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "position" TEXT NOT NULL,

    CONSTRAINT "FieldGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Field" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "groupId" TEXT,
    "labelSource" TEXT NOT NULL,
    "labelMeaning" TEXT,
    "dataType" "FieldType" NOT NULL DEFAULT 'TEXT',
    "mode" "FieldMode" NOT NULL DEFAULT 'EXTRACT',
    "note" TEXT,
    "choices" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "markSymbols" JSONB,
    "isSequence" BOOLEAN NOT NULL DEFAULT false,
    "position" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Field_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Mapping" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "outputColumnId" TEXT NOT NULL,
    "kind" "MappingKind" NOT NULL,
    "state" "MappingState" NOT NULL DEFAULT 'OK',
    "separator" TEXT,
    "splitBy" TEXT,
    "splitIndex" INTEGER,
    "splitRegex" TEXT,
    "constantValue" TEXT,
    "expression" TEXT,
    "fillDown" BOOLEAN NOT NULL DEFAULT true,
    "position" TEXT NOT NULL,

    CONSTRAINT "Mapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MappingInput" (
    "id" TEXT NOT NULL,
    "mappingId" TEXT NOT NULL,
    "fieldId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "MappingInput_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Batch" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "label" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Batch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Document" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "batchId" TEXT,
    "label" TEXT,
    "position" TEXT NOT NULL,
    "runState" "RunState" NOT NULL DEFAULT 'NEVER_RUN',
    "contentState" "ContentState" NOT NULL DEFAULT 'UNKNOWN',
    "templateMatchScore" DOUBLE PRECISION,
    "needsReview" BOOLEAN NOT NULL DEFAULT false,
    "lastRunAt" TIMESTAMPTZ(3),
    "lastModel" TEXT,
    "manualValues" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Photo" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "pageIndex" INTEGER NOT NULL,
    "originalKey" TEXT NOT NULL,
    "workingKey" TEXT,
    "thumbKey" TEXT,
    "mimeType" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "transform" JSONB,
    "status" "PhotoStatus" NOT NULL DEFAULT 'DRAFT',
    "errorMessage" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Photo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExtractionRun" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "passIndex" INTEGER NOT NULL DEFAULT 0,
    "idempotencyKey" TEXT NOT NULL,
    "state" "RunState" NOT NULL DEFAULT 'QUEUED',
    "startedAt" TIMESTAMPTZ(3),
    "finishedAt" TIMESTAMPTZ(3),
    "error" TEXT,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "rawResponse" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExtractionRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RawRecord" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "recordIndex" INTEGER NOT NULL,
    "rowType" "RowType" NOT NULL DEFAULT 'DATA',
    "struckThrough" BOOLEAN NOT NULL DEFAULT false,
    "sequenceValue" TEXT,
    "photoId" TEXT,
    "bbox" JSONB,
    "duplicateOf" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RawRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RawValue" (
    "id" TEXT NOT NULL,
    "rawRecordId" TEXT NOT NULL,
    "fieldId" TEXT NOT NULL,
    "valueText" TEXT,
    "altValueText" TEXT,
    "state" "ValueState" NOT NULL DEFAULT 'OK',
    "isDitto" BOOLEAN NOT NULL DEFAULT false,
    "confidence" DOUBLE PRECISION,
    "disagreement" BOOLEAN NOT NULL DEFAULT false,
    "photoId" TEXT,
    "bbox" JSONB,

    CONSTRAINT "RawValue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Row" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "rawRecordId" TEXT,
    "position" TEXT NOT NULL,
    "isVoid" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Row_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Cell" (
    "id" TEXT NOT NULL,
    "rowId" TEXT NOT NULL,
    "outputColumnId" TEXT NOT NULL,
    "extractedValue" TEXT,
    "currentValue" TEXT,
    "state" "ValueState" NOT NULL DEFAULT 'OK',
    "isEdited" BOOLEAN NOT NULL DEFAULT false,
    "isReviewed" BOOLEAN NOT NULL DEFAULT false,
    "inherited" BOOLEAN NOT NULL DEFAULT false,
    "confidence" DOUBLE PRECISION,
    "disagreement" BOOLEAN NOT NULL DEFAULT false,
    "validationState" "ValidationState" NOT NULL DEFAULT 'NONE',
    "validationMsgs" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Cell_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CellEdit" (
    "id" TEXT NOT NULL,
    "cellId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "previousValue" TEXT,
    "newValue" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CellEdit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ValidationRule" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "outputColumnId" TEXT,
    "kind" "RuleKind" NOT NULL,
    "params" JSONB NOT NULL,
    "message" TEXT,
    "severity" "RuleSeverity" NOT NULL DEFAULT 'WARNING',
    "enabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "ValidationRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "Account_userId_idx" ON "Account"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Account_provider_providerAccountId_key" ON "Account"("provider", "providerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_sessionToken_key" ON "Session"("sessionToken");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_token_key" ON "VerificationToken"("token");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_identifier_token_key" ON "VerificationToken"("identifier", "token");

-- CreateIndex
CREATE INDEX "Book_userId_deletedAt_idx" ON "Book"("userId", "deletedAt");

-- CreateIndex
CREATE INDEX "OutputColumn_bookId_deletedAt_idx" ON "OutputColumn"("bookId", "deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "OutputColumn_bookId_key_key" ON "OutputColumn"("bookId", "key");

-- CreateIndex
CREATE INDEX "GlossaryEntry_bookId_idx" ON "GlossaryEntry"("bookId");

-- CreateIndex
CREATE INDEX "Template_bookId_deletedAt_idx" ON "Template"("bookId", "deletedAt");

-- CreateIndex
CREATE INDEX "FieldGroup_templateId_idx" ON "FieldGroup"("templateId");

-- CreateIndex
CREATE INDEX "Field_templateId_deletedAt_idx" ON "Field"("templateId", "deletedAt");

-- CreateIndex
CREATE INDEX "Mapping_templateId_idx" ON "Mapping"("templateId");

-- CreateIndex
CREATE INDEX "Mapping_outputColumnId_idx" ON "Mapping"("outputColumnId");

-- CreateIndex
CREATE INDEX "MappingInput_fieldId_idx" ON "MappingInput"("fieldId");

-- CreateIndex
CREATE UNIQUE INDEX "MappingInput_mappingId_fieldId_position_key" ON "MappingInput"("mappingId", "fieldId", "position");

-- CreateIndex
CREATE INDEX "Batch_bookId_idx" ON "Batch"("bookId");

-- CreateIndex
CREATE INDEX "Document_bookId_deletedAt_idx" ON "Document"("bookId", "deletedAt");

-- CreateIndex
CREATE INDEX "Document_templateId_runState_idx" ON "Document"("templateId", "runState");

-- CreateIndex
CREATE INDEX "Document_batchId_idx" ON "Document"("batchId");

-- CreateIndex
CREATE INDEX "Photo_documentId_pageIndex_idx" ON "Photo"("documentId", "pageIndex");

-- CreateIndex
CREATE UNIQUE INDEX "ExtractionRun_idempotencyKey_key" ON "ExtractionRun"("idempotencyKey");

-- CreateIndex
CREATE INDEX "ExtractionRun_documentId_createdAt_idx" ON "ExtractionRun"("documentId", "createdAt");

-- CreateIndex
CREATE INDEX "ExtractionRun_state_idx" ON "ExtractionRun"("state");

-- CreateIndex
CREATE INDEX "RawRecord_documentId_recordIndex_idx" ON "RawRecord"("documentId", "recordIndex");

-- CreateIndex
CREATE INDEX "RawRecord_runId_idx" ON "RawRecord"("runId");

-- CreateIndex
CREATE INDEX "RawValue_fieldId_idx" ON "RawValue"("fieldId");

-- CreateIndex
CREATE UNIQUE INDEX "RawValue_rawRecordId_fieldId_key" ON "RawValue"("rawRecordId", "fieldId");

-- CreateIndex
CREATE INDEX "Row_bookId_position_idx" ON "Row"("bookId", "position");

-- CreateIndex
CREATE INDEX "Row_documentId_idx" ON "Row"("documentId");

-- CreateIndex
CREATE INDEX "Row_rawRecordId_idx" ON "Row"("rawRecordId");

-- CreateIndex
CREATE INDEX "Cell_outputColumnId_validationState_idx" ON "Cell"("outputColumnId", "validationState");

-- CreateIndex
CREATE INDEX "Cell_rowId_idx" ON "Cell"("rowId");

-- CreateIndex
CREATE UNIQUE INDEX "Cell_rowId_outputColumnId_key" ON "Cell"("rowId", "outputColumnId");

-- CreateIndex
CREATE INDEX "CellEdit_cellId_createdAt_idx" ON "CellEdit"("cellId", "createdAt");

-- CreateIndex
CREATE INDEX "CellEdit_userId_idx" ON "CellEdit"("userId");

-- CreateIndex
CREATE INDEX "ValidationRule_bookId_idx" ON "ValidationRule"("bookId");

-- CreateIndex
CREATE INDEX "ValidationRule_outputColumnId_idx" ON "ValidationRule"("outputColumnId");

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Book" ADD CONSTRAINT "Book_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutputColumn" ADD CONSTRAINT "OutputColumn_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GlossaryEntry" ADD CONSTRAINT "GlossaryEntry_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Template" ADD CONSTRAINT "Template_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FieldGroup" ADD CONSTRAINT "FieldGroup_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "Template"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Field" ADD CONSTRAINT "Field_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "Template"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Field" ADD CONSTRAINT "Field_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "FieldGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Mapping" ADD CONSTRAINT "Mapping_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "Template"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Mapping" ADD CONSTRAINT "Mapping_outputColumnId_fkey" FOREIGN KEY ("outputColumnId") REFERENCES "OutputColumn"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MappingInput" ADD CONSTRAINT "MappingInput_mappingId_fkey" FOREIGN KEY ("mappingId") REFERENCES "Mapping"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MappingInput" ADD CONSTRAINT "MappingInput_fieldId_fkey" FOREIGN KEY ("fieldId") REFERENCES "Field"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Batch" ADD CONSTRAINT "Batch_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "Template"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "Batch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Photo" ADD CONSTRAINT "Photo_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtractionRun" ADD CONSTRAINT "ExtractionRun_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RawRecord" ADD CONSTRAINT "RawRecord_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RawRecord" ADD CONSTRAINT "RawRecord_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ExtractionRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RawValue" ADD CONSTRAINT "RawValue_rawRecordId_fkey" FOREIGN KEY ("rawRecordId") REFERENCES "RawRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RawValue" ADD CONSTRAINT "RawValue_fieldId_fkey" FOREIGN KEY ("fieldId") REFERENCES "Field"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Row" ADD CONSTRAINT "Row_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Row" ADD CONSTRAINT "Row_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Row" ADD CONSTRAINT "Row_rawRecordId_fkey" FOREIGN KEY ("rawRecordId") REFERENCES "RawRecord"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cell" ADD CONSTRAINT "Cell_rowId_fkey" FOREIGN KEY ("rowId") REFERENCES "Row"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cell" ADD CONSTRAINT "Cell_outputColumnId_fkey" FOREIGN KEY ("outputColumnId") REFERENCES "OutputColumn"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CellEdit" ADD CONSTRAINT "CellEdit_cellId_fkey" FOREIGN KEY ("cellId") REFERENCES "Cell"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CellEdit" ADD CONSTRAINT "CellEdit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ValidationRule" ADD CONSTRAINT "ValidationRule_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ValidationRule" ADD CONSTRAINT "ValidationRule_outputColumnId_fkey" FOREIGN KEY ("outputColumnId") REFERENCES "OutputColumn"("id") ON DELETE CASCADE ON UPDATE CASCADE;
