-- CreateIndex
CREATE INDEX "Photo_originalKey_idx" ON "Photo"("originalKey");

-- CreateIndex
CREATE INDEX "Photo_workingKey_idx" ON "Photo"("workingKey");

-- CreateIndex
CREATE INDEX "Photo_thumbKey_idx" ON "Photo"("thumbKey");
