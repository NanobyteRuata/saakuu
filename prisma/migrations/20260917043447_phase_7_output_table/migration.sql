-- CreateEnum
CREATE TYPE "CellEditKind" AS ENUM ('EDIT', 'REVERT', 'UNDO');

-- AlterTable
ALTER TABLE "Book" ADD COLUMN     "confidenceThreshold" DOUBLE PRECISION NOT NULL DEFAULT 0.75;

-- AlterTable
ALTER TABLE "Cell" ADD COLUMN     "buildIssues" JSONB,
ADD COLUMN     "extractedState" "ValueState" NOT NULL DEFAULT 'OK';

-- AlterTable
ALTER TABLE "CellEdit" ADD COLUMN     "flags" JSONB,
ADD COLUMN     "kind" "CellEditKind" NOT NULL DEFAULT 'EDIT';

-- AlterTable
ALTER TABLE "Row" ADD COLUMN     "deletedAt" TIMESTAMPTZ(3);

-- Backfill: existing cells were never edited through the table, so their state is the extraction's state.
UPDATE "Cell" SET "extractedState" = state WHERE NOT "isEdited";

-- Backfill build issues from the stored messages (severity approximated by the cell's state; the next
-- rebuild writes them exactly). The required-column message now comes from validation, not the build.
UPDATE "Cell" c SET "buildIssues" = sub.issues
FROM (
  SELECT id, jsonb_agg(jsonb_build_object('severity', "validationState"::text, 'message', m)) AS issues
  FROM "Cell", unnest("validationMsgs") AS m
  WHERE "validationState" <> 'NONE' AND m <> 'This column is required.'
  GROUP BY id
) sub
WHERE c.id = sub.id;

