import type { MappingKind } from "@/lib/transform/types";

export const MAPPING_KIND_LABELS: Record<MappingKind, string> = {
  COPY: "Copy",
  CONCAT: "Join",
  SPLIT: "Split",
  CONSTANT: "Fixed value",
  EXPRESSION: "Expression",
};

export const MAPPING_KIND_HINTS: Record<MappingKind, string> = {
  COPY: "One field or tick group fills the column as it is.",
  CONCAT: "Several fields joined in order, with a separator between them. Empty fields are left out.",
  SPLIT: "Keeps one part of a field: split on a separator, or take the first bracketed group of a pattern.",
  CONSTANT: "The same value for every row read with this template.",
  EXPRESSION:
    "A small formula. Insert fields with the picker. + joins text; use number() for sums. Functions: concat, substring, replace, trim, upper, lower, if, number, text, default, floor, ceil, round.",
};
