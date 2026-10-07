import type { MultipleMarked, NoneMarked, TickSelection } from "@/lib/templates/schemas";
import type { MappingKind } from "@/lib/transform/types";

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
