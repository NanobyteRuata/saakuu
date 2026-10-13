-- Phase 27 (decision 87). A field has one of five types: Whole number, Age and Fraction become Number.
-- Prompt v5 already sends all four as NUMBER with one hint, so what the AI is told does not change;
-- and since Phase 26 every mapping input carries its own "readAs", so no cell changes either.
-- "Field"."typeOptions" (unread since Phase 26) is dropped, and "Field"."markSymbols" becomes the plain
-- list of symbols used on the paper, in the order they are sent today. What each symbol means lives on
-- "MappingInput"."readAs".

-- Mark symbols were only ever stored as an object of symbol -> meaning. Anything else has no certain
-- list, so stop rather than guess. Nothing has been changed when this raises.
DO $$
DECLARE
  odd_symbols integer;
BEGIN
  SELECT count(*) INTO odd_symbols
  FROM "Field" f
  WHERE f."markSymbols" IS NOT NULL AND f."markSymbols" <> 'null'::jsonb AND (
    jsonb_typeof(f."markSymbols") <> 'object'
    OR (SELECT count(*) FROM jsonb_object_keys(CASE WHEN jsonb_typeof(f."markSymbols") = 'object' THEN f."markSymbols" ELSE '{}'::jsonb END)) > 20
    OR EXISTS (
      SELECT 1 FROM jsonb_object_keys(CASE WHEN jsonb_typeof(f."markSymbols") = 'object' THEN f."markSymbols" ELSE '{}'::jsonb END) k
      WHERE k <> btrim(k) OR char_length(k) NOT BETWEEN 1 AND 20)
  );
  IF odd_symbols > 0 THEN
    RAISE EXCEPTION 'Phase 27: % field(s) hold mark symbols in an unexpected shape. Settle them by hand before migrating.', odd_symbols;
  END IF;
END $$;

-- AlterEnum
CREATE TYPE "FieldType_new" AS ENUM ('TEXT', 'NUMBER', 'DATE', 'MARK', 'CHOICE');
ALTER TABLE "Field" ALTER COLUMN "dataType" DROP DEFAULT;
ALTER TABLE "Field" ALTER COLUMN "dataType" TYPE "FieldType_new" USING (
  CASE WHEN "dataType"::text IN ('INTEGER', 'AGE', 'FRACTION') THEN 'NUMBER' ELSE "dataType"::text END::"FieldType_new"
);
ALTER TYPE "FieldType" RENAME TO "FieldType_old";
ALTER TYPE "FieldType_new" RENAME TO "FieldType";
DROP TYPE "FieldType_old";
ALTER TABLE "Field" ALTER COLUMN "dataType" SET DEFAULT 'TEXT';

-- AlterTable: the symbols as a list, in the order the object held them (the order the prompt lists them in).
ALTER TABLE "Field" ADD COLUMN "markSymbols_new" TEXT[] DEFAULT ARRAY[]::TEXT[];

UPDATE "Field" f
SET "markSymbols_new" = (
  SELECT coalesce(array_agg(t.k ORDER BY t.ord), ARRAY[]::TEXT[])
  FROM jsonb_object_keys(f."markSymbols") WITH ORDINALITY AS t(k, ord)
)
WHERE jsonb_typeof(f."markSymbols") = 'object';

ALTER TABLE "Field" DROP COLUMN "markSymbols";
ALTER TABLE "Field" RENAME COLUMN "markSymbols_new" TO "markSymbols";
ALTER TABLE "Field" DROP COLUMN "typeOptions";
