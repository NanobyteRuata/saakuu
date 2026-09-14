import type { RunSummary } from "./config-state";
import type { ConfigState, FieldMode, FieldType, TemplateKind } from "./schemas";

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
  SKIP: "The AI is told to ignore this field.",
  MANUAL: "Never sent to the AI. You type it once per document.",
};

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
