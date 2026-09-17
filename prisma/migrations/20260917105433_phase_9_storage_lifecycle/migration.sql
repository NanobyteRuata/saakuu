-- CreateEnum
CREATE TYPE "StorageDeletionReason" AS ENUM ('PHOTO_DELETED', 'DOCUMENT_PURGED');

-- CreateTable
CREATE TABLE "StorageDeletion" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "photoId" TEXT NOT NULL,
    "originalKey" TEXT NOT NULL,
    "reason" "StorageDeletionReason" NOT NULL,
    "deleteAfter" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StorageDeletion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StorageDeletion_photoId_key" ON "StorageDeletion"("photoId");

-- CreateIndex
CREATE INDEX "StorageDeletion_deleteAfter_idx" ON "StorageDeletion"("deleteAfter");

-- CreateIndex
CREATE INDEX "StorageDeletion_originalKey_idx" ON "StorageDeletion"("originalKey");
