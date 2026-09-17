-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "transformFlags" JSONB;

-- AlterTable
ALTER TABLE "MappingInput" ADD COLUMN     "groupId" TEXT,
ADD COLUMN     "noneValue" TEXT,
ADD COLUMN     "optionValues" JSONB,
ALTER COLUMN "fieldId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Row" ADD COLUMN     "recordKey" TEXT,
ADD COLUMN     "voidReason" TEXT;

-- CreateIndex
CREATE INDEX "MappingInput_groupId_idx" ON "MappingInput"("groupId");

-- AddForeignKey
ALTER TABLE "MappingInput" ADD CONSTRAINT "MappingInput_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "FieldGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A mapping input reads a field or a group, never both (both null: its group was deleted).
ALTER TABLE "MappingInput" ADD CONSTRAINT "MappingInput_one_source_check" CHECK ("fieldId" IS NULL OR "groupId" IS NULL);
