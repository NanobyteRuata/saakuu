-- AlterTable
ALTER TABLE "ExtractionRun" ADD COLUMN     "photoIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
