import type { MultipleMarked, NoneMarked, TickSelection } from "@/lib/templates/schemas";
import type { MappingKind } from "@/lib/transform/types";

import type { ReadAsKind } from "./read-as";

export const MAPPING_KIND_LABELS: Record<MappingKind, string> = {
  COPY: "Copy",
  CONCAT: "Join",
  SPLIT: "Split",
  CONSTANT: "Fixed value",
  EXPRESSION: "Expression",
  TICKS: "From ticks",
};

export const MAPPING_KIND_HINTS: Record<MappingKind, string> = {
  COPY: "One field fills the column as it is.",
  CONCAT: "Several fields joined in order, with a separator between them. Empty fields are left out.",
  SPLIT: "Keeps one part of a field: split on a separator, or take the first bracketed group of a pattern.",
  CONSTANT: "The same value for every row read with this template.",
  EXPRESSION:
    "A small formula. Insert fields with the picker. + joins text; use number() for sums. Functions: concat, substring, replace, trim, upper, lower, if, number, text, default, floor, ceil, round.",
  TICKS: "Several tick boxes become one answer, e.g. a tick under ကျား or မ becomes M or F. You choose the tick fields and what each one writes.",
};

export const READ_AS_LABELS: Record<ReadAsKind, string> = {
  TEXT: "As written",
  NUMBER: "Number",
  DATE: "Date",
  AGE: "Age",
  FRACTION: "Fraction",
  MARK: "Mark / tick",
  CHOICE: "Choice",
};

/** Date, Age and Mark explain themselves through their own options. */
export const READ_AS_HINTS: Record<ReadAsKind, string> = {
  TEXT: "Kept as the AI read it.",
  NUMBER: "Digits in any script become a plain number. Anything that isn't a number is kept as written.",
  DATE: "Day/month/year in any digits becomes a date.",
  AGE: "1 1/2, 4/12 or 1y 6m becomes an age in the unit you choose.",
  FRACTION: "1 1/2 becomes 1.5 and 3/4 becomes 0.75.",
  MARK: "A tick becomes yes or no, by what each symbol means.",
  CHOICE: "Matched to the field's choices. A near miss is matched and flagged.",
};

export const TICK_SELECTION_LABELS: Record<TickSelection, string> = { ONE_OF: "Only one", ANY_OF: "Several" };

export const TICK_SELECTION_HINTS: Record<TickSelection, string> = {
  ONE_OF: "One box is ticked per row, e.g. Sex. The ticked one's value fills the column.",
  ANY_OF: "Several boxes can be ticked, e.g. symptoms. The ticked ones' values are joined with commas.",
};

export const NONE_MARKED_LABELS: Record<NoneMarked, string> = { BLANK: "Leave blank", REVIEW: "Leave blank and flag it", ERROR: "Mark as an error" };

export const NONE_MARKED_HINTS: Record<NoneMarked, string> = {
  BLANK: "Nothing ticked is a normal answer, e.g. not tested: no flag.",
  REVIEW: "A row with nothing ticked is flagged for you to check.",
  ERROR: "A row with nothing ticked is marked as an error.",
};

export const MULTIPLE_MARKED_LABELS: Record<MultipleMarked, string> = { REVIEW: "Flag it", ERROR: "Mark as an error" };

export const MULTIPLE_MARKED_HINTS: Record<MultipleMarked, string> = {
  REVIEW: "The cell is left blank and flagged for you to check. No box is picked for you.",
  ERROR: "The cell is left blank and marked as an error. No box is picked for you.",
};
