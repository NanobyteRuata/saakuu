-- Phase 14: cutting what nobody needs. One destructive drop, safe because nothing is launched.
-- Book.confidenceThreshold asked a non-technical operator for a percentage controlling a dotted
-- underline, over the model's own self-reported confidence — an uncalibrated signal the settings
-- help text already conceded was "only a hint". A tuning knob with no feedback loop (decision 77).
-- It becomes the constant DEFAULT_CONFIDENCE_THRESHOLD in lib/table/cellState.ts.
-- Book.defaultModel, numeralSystem, dateEra, blankToken and illegibleToken keep their columns: the
-- prompt, the transform and the export still read them. Only their settings UI goes.

-- AlterTable
ALTER TABLE "Book" DROP COLUMN "confidenceThreshold";
