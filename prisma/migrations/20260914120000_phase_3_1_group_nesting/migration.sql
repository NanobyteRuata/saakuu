-- Phase 3.1: nested groups that share one order with fields, and selection settings.

-- CreateEnum
CREATE TYPE "GroupSelection" AS ENUM ('NONE', 'ONE_OF', 'ANY_OF');

-- CreateEnum
CREATE TYPE "NoneMarked" AS ENUM ('BLANK', 'REVIEW', 'ERROR');

-- CreateEnum
CREATE TYPE "MultipleMarked" AS ENUM ('REVIEW', 'ERROR');

-- AlterTable: rename keeps existing labels (no drop and re-add).
ALTER TABLE "FieldGroup" RENAME COLUMN "label" TO "labelSource";

ALTER TABLE "FieldGroup"
ADD COLUMN     "labelMeaning" TEXT,
ADD COLUMN     "multipleMarked" "MultipleMarked" NOT NULL DEFAULT 'ERROR',
ADD COLUMN     "noneMarked" "NoneMarked" NOT NULL DEFAULT 'REVIEW',
ADD COLUMN     "note" TEXT,
ADD COLUMN     "parentGroupId" TEXT,
ADD COLUMN     "selection" "GroupSelection" NOT NULL DEFAULT 'NONE';

-- CreateIndex
CREATE INDEX "FieldGroup_parentGroupId_idx" ON "FieldGroup"("parentGroupId");

-- AddForeignKey
ALTER TABLE "FieldGroup" ADD CONSTRAINT "FieldGroup_parentGroupId_fkey" FOREIGN KEY ("parentGroupId") REFERENCES "FieldGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
