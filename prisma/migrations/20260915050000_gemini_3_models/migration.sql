-- Gemini 2.5 models are no longer available to new API keys.
-- Flash moves to Gemini 3.5 Flash; Pro (no quota on free plans) moves to the newer Gemini 3.7 Flash.
-- ExtractionRun.model is history and is left as it was.

ALTER TABLE "Book" ALTER COLUMN "defaultModel" SET DEFAULT 'gemini-3.5-flash';

UPDATE "Book" SET "defaultModel" = 'gemini-3.5-flash' WHERE "defaultModel" = 'gemini-2.5-flash';
UPDATE "Book" SET "defaultModel" = 'gemini-3.7-flash' WHERE "defaultModel" = 'gemini-2.5-pro';

UPDATE "Template" SET "modelOverride" = 'gemini-3.5-flash' WHERE "modelOverride" = 'gemini-2.5-flash';
UPDATE "Template" SET "modelOverride" = 'gemini-3.7-flash' WHERE "modelOverride" = 'gemini-2.5-pro';
