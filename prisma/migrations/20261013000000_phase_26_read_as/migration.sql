-- Phase 26 (decision 86). Fields are what the AI is told; conversion belongs to each field a mapping
-- reads. Every MappingInput gets "readAs": how its field's reading is converted before the mapping
-- uses it. It is filled from the field as it stands today, so nothing that reaches a row changes:
--   Text -> as written        Number, Whole number -> number      Fraction -> fraction
--   Date -> date, with the field's two-digit-year rule (none recorded = flag)
--   Age  -> age, with the field's unit (none recorded = months, decision 85)
--   Choice -> choice          Mark -> mark, with the field's symbol meanings
-- Inputs of soft-deleted fields are filled the same way, so a restore gives the same cells.
-- "Field"."typeOptions" and "Field"."markSymbols" are left exactly as they are, unread from now on.

-- A stored setting the app would not have understood has no certain equivalent, so stop rather than
-- guess what it meant. Nothing has been changed when this raises.
DO $$
DECLARE
  odd_options integer;
  odd_symbols integer;
BEGIN
  SELECT count(*) INTO odd_options
  FROM "Field" f
  WHERE f."typeOptions" IS NOT NULL AND f."typeOptions" <> 'null'::jsonb AND (
    jsonb_typeof(f."typeOptions") <> 'object'
    OR (f."typeOptions" ? 'date' AND (
          jsonb_typeof(f."typeOptions" -> 'date') <> 'object'
       OR coalesce(jsonb_typeof(f."typeOptions" #> '{date,twoDigitYear}'), 'string') <> 'string'
       OR coalesce(f."typeOptions" #>> '{date,twoDigitYear}', 'REFUSE') NOT IN ('REFUSE', 'CENTURY', 'PIVOT')
       OR coalesce(jsonb_typeof(f."typeOptions" #> '{date,pivotYear}'), 'null') NOT IN ('null', 'number')
       OR coalesce(f."typeOptions" #>> '{date,pivotYear}', '0') !~ '^[0-9]{1,2}$'
       OR (f."typeOptions" #>> '{date,twoDigitYear}' = 'PIVOT' AND f."typeOptions" #>> '{date,pivotYear}' IS NULL)))
    OR (f."typeOptions" ? 'age' AND (
          jsonb_typeof(f."typeOptions" -> 'age') <> 'object'
       OR coalesce(jsonb_typeof(f."typeOptions" #> '{age,unit}'), 'x') <> 'string'
       OR f."typeOptions" #>> '{age,unit}' NOT IN ('YEARS', 'MONTHS', 'YEARS_MONTHS')))
  );
  IF odd_options > 0 THEN
    RAISE EXCEPTION 'Phase 26: % field(s) hold date or age settings in an unexpected shape. Settle them by hand before migrating.', odd_options;
  END IF;

  SELECT count(*) INTO odd_symbols
  FROM "Field" f
  WHERE f."markSymbols" IS NOT NULL AND f."markSymbols" <> 'null'::jsonb AND (
    jsonb_typeof(f."markSymbols") <> 'object'
    OR (SELECT count(*) FROM jsonb_each(CASE WHEN jsonb_typeof(f."markSymbols") = 'object' THEN f."markSymbols" ELSE '{}'::jsonb END)) > 20
    OR EXISTS (
      SELECT 1 FROM jsonb_each(CASE WHEN jsonb_typeof(f."markSymbols") = 'object' THEN f."markSymbols" ELSE '{}'::jsonb END) e
      WHERE e.value NOT IN ('true'::jsonb, 'false'::jsonb, '"count"'::jsonb)
         OR e.key <> btrim(e.key) OR char_length(e.key) NOT BETWEEN 1 AND 20)
  );
  IF odd_symbols > 0 THEN
    RAISE EXCEPTION 'Phase 26: % field(s) hold mark symbols in an unexpected shape. Settle them by hand before migrating.', odd_symbols;
  END IF;
END $$;

-- AlterTable
ALTER TABLE "MappingInput" ADD COLUMN "readAs" JSONB;

UPDATE "MappingInput" mi
SET "readAs" = CASE f."dataType"
  WHEN 'TEXT' THEN '{"kind": "TEXT"}'::jsonb
  WHEN 'NUMBER' THEN '{"kind": "NUMBER"}'::jsonb
  WHEN 'INTEGER' THEN '{"kind": "NUMBER"}'::jsonb
  WHEN 'FRACTION' THEN '{"kind": "FRACTION"}'::jsonb
  WHEN 'CHOICE' THEN '{"kind": "CHOICE"}'::jsonb
  WHEN 'DATE' THEN jsonb_build_object(
    'kind', 'DATE',
    'twoDigitYear', coalesce(f."typeOptions" #>> '{date,twoDigitYear}', 'REFUSE'),
    'pivotYear', coalesce(f."typeOptions" #> '{date,pivotYear}', 'null'::jsonb))
  WHEN 'AGE' THEN jsonb_build_object('kind', 'AGE', 'unit', coalesce(f."typeOptions" #>> '{age,unit}', 'MONTHS'))
  WHEN 'MARK' THEN jsonb_build_object(
    'kind', 'MARK',
    'symbols', CASE WHEN jsonb_typeof(f."markSymbols") = 'object' THEN f."markSymbols" ELSE '{}'::jsonb END)
END
FROM "Field" f
WHERE f."id" = mi."fieldId";

-- Every source carries its own answer from here on; a type this file doesn't know stops it.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "MappingInput" WHERE "readAs" IS NULL) THEN
    RAISE EXCEPTION 'Phase 26: a mapping input was left without a Read as.';
  END IF;
END $$;

ALTER TABLE "MappingInput" ALTER COLUMN "readAs" SET NOT NULL;
