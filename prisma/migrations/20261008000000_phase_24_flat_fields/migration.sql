-- Phase 24: flat fields (decision 84). Headers stop being rows of their own: a field carries the
-- header above it as text, and FieldGroup holds tick sets only (One of / Any of), one level deep.
--
-- Nothing that reaches a row changes: every field keeps its header words and its place in paper
-- order, every tick set keeps its options, and every mapping keeps the value it exports per option.

-- AlterTable
ALTER TABLE "Field" ADD COLUMN "headerSource" TEXT,
ADD COLUMN "headerMeaning" TEXT;

-- Every group with the headers from the top down to itself, in the old paper order.
CREATE TEMP TABLE "_group_chain" ON COMMIT DROP AS
WITH RECURSIVE chain AS (
  SELECT
    g."id",
    ARRAY[g."labelSource"] AS sources,
    ARRAY[coalesce(g."labelMeaning", g."labelSource")] AS meanings,
    g."labelMeaning" IS NOT NULL AS has_meaning,
    CASE WHEN g."selection" = 'NONE' AND g."note" IS NOT NULL THEN ARRAY[g."note"] ELSE ARRAY[]::text[] END AS notes,
    -- The nearest group at or above this one that is a tick set, and the headers below it.
    CASE WHEN g."selection" <> 'NONE' THEN g."id" END AS tick_id,
    ARRAY[]::text[] AS below_tick,
    ARRAY[g."position", g."id"] AS sort_path
  FROM "FieldGroup" g
  WHERE g."parentGroupId" IS NULL
  UNION ALL
  SELECT
    c."id",
    p.sources || c."labelSource",
    p.meanings || coalesce(c."labelMeaning", c."labelSource"),
    p.has_meaning OR c."labelMeaning" IS NOT NULL,
    CASE WHEN c."selection" = 'NONE' AND c."note" IS NOT NULL THEN p.notes || c."note" ELSE p.notes END,
    CASE WHEN c."selection" <> 'NONE' THEN c."id" ELSE p.tick_id END,
    CASE
      WHEN c."selection" <> 'NONE' THEN ARRAY[]::text[]
      WHEN p.tick_id IS NOT NULL THEN p.below_tick || coalesce(c."labelMeaning", c."labelSource")
      ELSE ARRAY[]::text[]
    END,
    p.sort_path || ARRAY[c."position", c."id"]
  FROM "FieldGroup" c
  JOIN chain p ON p."id" = c."parentGroupId"
)
SELECT * FROM chain;

-- A tick option's default output used to be its path below the tick set ("Positive › A"). It is now
-- the field's own label, so the old value is written into each mapping that relied on it. Values a
-- mapping already sets win.
WITH option_default AS (
  SELECT
    f."id" AS field_id,
    gc.tick_id,
    array_to_string(gc.below_tick || coalesce(f."labelMeaning", f."labelSource"), ' › ') AS old_default,
    cardinality(gc.below_tick) > 0
      OR count(*) FILTER (WHERE f."deletedAt" IS NULL AND f."mode" <> 'SKIP')
           OVER (PARTITION BY gc.tick_id, coalesce(f."labelMeaning", f."labelSource")) > 1 AS changes
  FROM "Field" f
  JOIN "_group_chain" gc ON gc."id" = f."groupId"
  WHERE gc.tick_id IS NOT NULL AND f."dataType" = 'MARK'
),
frozen AS (
  SELECT tick_id, jsonb_object_agg(field_id, old_default) AS defaults
  FROM option_default
  WHERE changes
  GROUP BY tick_id
)
UPDATE "MappingInput" mi
SET "optionValues" = frozen.defaults || coalesce(CASE WHEN jsonb_typeof(mi."optionValues") = 'object' THEN mi."optionValues" END, '{}'::jsonb)
FROM frozen
WHERE mi."groupId" = frozen.tick_id;

-- Paper order becomes one list per template: the old tree read top to bottom.
WITH ordered AS (
  SELECT
    f."id",
    row_number() OVER (
      PARTITION BY f."templateId"
      ORDER BY (coalesce(gc.sort_path, ARRAY[]::text[]) || ARRAY[f."position", f."id"]) COLLATE "C"
    ) - 1 AS n
  FROM "Field" f
  LEFT JOIN "_group_chain" gc ON gc."id" = f."groupId"
  WHERE f."templateId" IN (SELECT "templateId" FROM "FieldGroup")
),
alphabet AS (
  SELECT '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz' AS digits
)
UPDATE "Field" f
SET "position" = 'c'
  || substr(a.digits, (o.n / 3844)::int % 62 + 1, 1)
  || substr(a.digits, (o.n / 62)::int % 62 + 1, 1)
  || substr(a.digits, (o.n % 62)::int + 1, 1)
FROM ordered o, alphabet a
WHERE f."id" = o."id";

-- Header words, the notes of the headers that go away, and membership of the tick set (if any).
UPDATE "Field" f
SET
  "headerSource" = array_to_string(gc.sources, ' › '),
  "headerMeaning" = CASE WHEN gc.has_meaning THEN array_to_string(gc.meanings, ' › ') END,
  "note" = CASE
    WHEN cardinality(gc.notes) = 0 THEN f."note"
    ELSE concat_ws(E'\n', array_to_string(gc.notes, E'\n'), f."note")
  END,
  "groupId" = gc.tick_id
FROM "_group_chain" gc
WHERE gc."id" = f."groupId";

-- Plain headers are gone; what is left in FieldGroup is tick sets.
DROP INDEX "FieldGroup_parentGroupId_idx";
ALTER TABLE "FieldGroup" DROP CONSTRAINT "FieldGroup_parentGroupId_fkey";
ALTER TABLE "FieldGroup" DROP COLUMN "parentGroupId",
DROP COLUMN "position";

DELETE FROM "FieldGroup" WHERE "selection" = 'NONE';

-- AlterEnum
ALTER TABLE "FieldGroup" ALTER COLUMN "selection" DROP DEFAULT;
CREATE TYPE "GroupSelection_new" AS ENUM ('ONE_OF', 'ANY_OF');
ALTER TABLE "FieldGroup" ALTER COLUMN "selection" TYPE "GroupSelection_new" USING ("selection"::text::"GroupSelection_new");
DROP TYPE "GroupSelection";
ALTER TYPE "GroupSelection_new" RENAME TO "GroupSelection";
