-- An Age field now chooses how its value comes out (`Field.typeOptions.age.unit`): years by default,
-- total months, or years and months. Until now every Age field came out as total months, so the ones
-- that exist keep that: no cell in an existing book changes. The code already reads a missing unit as
-- months, so this only writes down what those fields mean; nothing depends on it having run.
UPDATE "Field"
SET "typeOptions" = jsonb_set(
  CASE WHEN jsonb_typeof("typeOptions") = 'object' THEN "typeOptions" ELSE '{}'::jsonb END,
  '{age}',
  '{"unit": "MONTHS"}'::jsonb
)
WHERE "dataType" = 'AGE';
