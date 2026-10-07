import type { DateEra } from "@/lib/books/schemas";

import type { RunSummary } from "./config-state";
import type {
  ConfigState,
  FieldMode,
  FieldType,
  TemplateKind,
  TwoDigitYearRule,
} from "./schemas";

export const TEMPLATE_KIND_LABELS: Record<TemplateKind, string> = { FORM: "Form", TABLE: "Table" };

export const CONFIG_STATE_LABELS: Record<ConfigState, string> = {
  DRAFT: "Draft",
  READY: "Ready",
  CONFLICTED: "Conflicted",
};

export const FIELD_TYPE_LABELS: Record<FieldType, string> = {
  TEXT: "Text",
  NUMBER: "Number",
  INTEGER: "Whole number",
  DATE: "Date",
  MARK: "Mark / tick",
  CHOICE: "Choice",
  AGE: "Age",
  FRACTION: "Fraction",
};

export const FIELD_MODE_LABELS: Record<FieldMode, string> = { EXTRACT: "Extract", SKIP: "Skip", MANUAL: "Manual" };

export const FIELD_MODE_HINTS: Record<FieldMode, string> = {
  EXTRACT: "The AI reads this field.",
  SKIP: "On the paper, but the AI ignores it and the cell stays empty. Listing it keeps neighbouring values in the right place.",
  MANUAL: "Never sent to the AI. You type it once per document.",
};

/** Which fields to add (docs/01 §6.5), shown in the empty state and under Mode. */
export const FIELD_GUIDANCE: Record<TemplateKind, string> = {
  TABLE:
    "Add every column on the paper, in paper order, and set the ones you don't need to Skip. A column left out gives its handwriting nowhere to go, so it drifts into a neighbour.",
  FORM: "Add the fields you want. Also add look-alikes, such as mother's and father's name or two different dates, as Skip so the AI can tell them apart.",
};

export const TWO_DIGIT_YEAR_LABELS: Record<TwoDigitYearRule, string> = {
  REFUSE: "Flag them (default)",
  CENTURY: "Read them in this century",
  PIVOT: "Split at a year",
};

/** The century a two-digit year is read in, per the book's era: 20xx, 25xx (Buddhist) or 13xx (Myanmar). */
export const ERA_CENTURY_EXAMPLE: Record<DateEra, string> = { GREGORIAN: "20", BUDDHIST: "25", MYANMAR: "13" };

export function twoDigitYearHint(rule: TwoDigitYearRule, era: DateEra, pivotYear: number | null): string {
  const century = ERA_CENTURY_EXAMPLE[era];
  switch (rule) {
    case "REFUSE":
      return "A date like 30.8.20 is flagged, because the century isn't written. You type the full date while reviewing.";
    case "CENTURY":
      return `30.8.20 is read as ${century}20-08-30. Use this when every date on the paper is from this century.`;
    case "PIVOT": {
      if (pivotYear === null) return "Enter the year two-digit dates split at, from 0 to 99.";
      const previous = Number(century) - 1;
      return `Years from ${String(pivotYear).padStart(2, "0")} to 99 are read as ${previous}xx, below that as ${century}xx. Use this when the register mixes old and recent dates.`;
    }
  }
}

export const LANGUAGE_HINTS = [
  { value: "my", label: "Burmese" },
  { value: "en", label: "English" },
  { value: "my,en", label: "Burmese and English" },
] as const;

export function runSummaryLabel(run: RunSummary): string {
  switch (run.state) {
    case "NEVER_RUN":
      return "Never run";
    case "RUNNING":
      return `Running ${run.done}/${run.total}`;
    case "FAILED":
      return "Failed";
    case "PARTIAL":
      return "Partial";
    case "COMPLETE":
      return "Complete";
  }
}

/** First language tag of a hint, for `lang` attributes. */
export function langOf(hint: string | null): string | undefined {
  return hint?.split(",")[0] || undefined;
}
