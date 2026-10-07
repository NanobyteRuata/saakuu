-- Phase 24, second half (decision 84). A field is one box on the paper with one name: the header
-- above it is folded into the name with " › ", and tick sets leave the source layer. Combining tick
-- fields into one answer becomes a mapping kind (TICKS) that carries the rules and one value per tick.
--
-- Nothing that reaches a row changes: every mapping that read a tick set keeps its options in paper
-- order, the value each one writes, One of / Any of, and both of its rules. Tick sets that no mapping
-- reads go away; their fields stay as ordinary tick fields.

-- A tick set read from inside a Join or an Expression has no equivalent, so stop rather than change
-- what that mapping exports.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "MappingInput" mi
    JOIN "Mapping" m ON m."id" = mi."mappingId"
    WHERE mi."groupId" IS NOT NULL
      AND (m."kind" <> 'COPY' OR (SELECT count(*) FROM "MappingInput" x WHERE x."mappingId" = m."id") <> 1)
  ) THEN
    RAISE EXCEPTION 'Phase 24: a mapping other than a one-input Copy reads a tick set. Rework it by hand before migrating.';
  END IF;
END $$;

-- AlterEnum (recreated, not ADD VALUE: a value added in this transaction could not be used in it)
CREATE TYPE "MappingKind_new" AS ENUM ('COPY', 'CONCAT', 'SPLIT', 'CONSTANT', 'EXPRESSION', 'TICKS');
ALTER TABLE "Mapping" ALTER COLUMN "kind" TYPE "MappingKind_new" USING ("kind"::text::"MappingKind_new");
DROP TYPE "MappingKind";
ALTER TYPE "MappingKind_new" RENAME TO "MappingKind";

ALTER TYPE "GroupSelection" RENAME TO "TickSelection";

-- AlterTable
ALTER TABLE "Mapping" ADD COLUMN "tickSelection" "TickSelection",
ADD COLUMN "noneMarked" "NoneMarked",
ADD COLUMN "multipleMarked" "MultipleMarked",
ADD COLUMN "noneValue" TEXT,
ADD COLUMN "tickLabel" TEXT;

ALTER TABLE "MappingInput" ADD COLUMN "tickValue" TEXT;

-- One input per live field of the tick set, in paper order, with the value it writes today: the
-- mapping's own value for that option, else the option's default (its meaning or label, with the
-- header in front when two options of the set read the same). Written out in full, so the value no
-- longer depends on the label, which is about to change.
WITH member AS (
  SELECT
    mi."mappingId",
    mi."optionValues",
    f."id" AS field_id,
    f."position",
    coalesce(f."labelMeaning", f."labelSource") AS own,
    nullif(coalesce(f."headerMeaning", f."headerSource"), '') AS header,
    f."dataType" = 'MARK' AND f."mode" <> 'SKIP' AS is_option
  FROM "MappingInput" mi
  JOIN "Field" f ON f."groupId" = mi."groupId" AND f."deletedAt" IS NULL
  WHERE mi."groupId" IS NOT NULL
),
valued AS (
  SELECT
    m.*,
    count(*) FILTER (WHERE m.is_option) OVER (PARTITION BY m."mappingId", m.own) > CASE WHEN m.is_option THEN 1 ELSE 0 END AS clash,
    row_number() OVER (PARTITION BY m."mappingId" ORDER BY m."position" COLLATE "C", m.field_id COLLATE "C") - 1 AS n
  FROM member m
)
INSERT INTO "MappingInput" ("id", "mappingId", "fieldId", "position", "tickValue")
SELECT
  'p' || substr(md5(v."mappingId" || v.field_id), 1, 23),
  v."mappingId",
  v.field_id,
  v.n,
  coalesce(
    CASE WHEN jsonb_typeof(v."optionValues") = 'object' THEN v."optionValues" ->> v.field_id END,
    CASE WHEN v.clash AND v.header IS NOT NULL THEN v.header || ' › ' || v.own ELSE v.own END
  )
FROM valued v;

-- The rules and the name move from the tick set to the mapping that reads it.
UPDATE "Mapping" m
SET
  "kind" = 'TICKS',
  "tickSelection" = g."selection",
  "noneMarked" = g."noneMarked",
  "multipleMarked" = g."multipleMarked",
  "noneValue" = nullif(mi."noneValue", ''),
  "tickLabel" = g."labelSource"
FROM "MappingInput" mi
JOIN "FieldGroup" g ON g."id" = mi."groupId"
WHERE mi."mappingId" = m."id";

-- A tick set's note is an instruction to the AI: it goes to the fields it was about.
UPDATE "Field" f
SET "note" = concat_ws(E'\n', g."note", f."note")
FROM "FieldGroup" g
WHERE g."id" = f."groupId" AND g."note" IS NOT NULL;

-- The old tick-set inputs, and inputs whose tick set was already deleted (those mappings stay broken).
DELETE FROM "MappingInput" WHERE "fieldId" IS NULL;

-- The header becomes the front of the name. Both right-hand sides read the old values.
UPDATE "Field"
SET
  "labelMeaning" = CASE
    WHEN "headerMeaning" IS NOT NULL OR "labelMeaning" IS NOT NULL
      THEN coalesce("headerMeaning", "headerSource") || ' › ' || coalesce("labelMeaning", "labelSource")
  END,
  "labelSource" = "headerSource" || ' › ' || "labelSource"
WHERE "headerSource" IS NOT NULL AND "headerSource" <> '';

-- DropForeignKey
ALTER TABLE "Field" DROP CONSTRAINT "Field_groupId_fkey";
ALTER TABLE "MappingInput" DROP CONSTRAINT "MappingInput_groupId_fkey";

-- DropIndex
DROP INDEX "MappingInput_groupId_idx";

-- AlterTable
ALTER TABLE "Field" DROP COLUMN "groupId",
DROP COLUMN "headerSource",
DROP COLUMN "headerMeaning";

ALTER TABLE "MappingInput" DROP COLUMN "groupId",
DROP COLUMN "optionValues",
DROP COLUMN "noneValue",
ALTER COLUMN "fieldId" SET NOT NULL;

-- DropTable
DROP TABLE "FieldGroup";
