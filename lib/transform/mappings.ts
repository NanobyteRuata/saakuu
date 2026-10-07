import { isTickOption, type FieldList } from "@/lib/templates/field-list";
import { FIELD_TYPE_LABELS } from "@/lib/templates/labels";

import { parseExpression } from "./expression";
import type { MappingSource, TransformField, TransformMapping } from "./types";

/**
 * Mapping rules (docs/01 §6.5b, docs/03 §8 step 6). Pure: the save-time check, broken-mapping
 * detection and the transform all use these, so they can't disagree about what works.
 */

export type SourceFields = FieldList<TransformField>;

export type MappingShape = Omit<TransformMapping, "id" | "outputColumnId">;

export const DEFAULT_SEPARATOR = ", ";
/** Several ticked fields of a From ticks mapping are joined with this. */
export const OPTION_SEPARATOR = ", ";

/** What a From ticks mapping is set to when the form leaves a rule alone. */
export const DEFAULT_TICK_RULES = { selection: "ONE_OF", noneMarked: "REVIEW", multipleMarked: "ERROR", noneValue: null, label: null } as const;

/** Clears options that belong to other kinds, so a stored mapping carries only what it uses. */
export function tidyMapping<T extends MappingShape>(m: T): T {
  return {
    ...m,
    separator: m.kind === "CONCAT" ? m.separator : null,
    splitBy: m.kind === "SPLIT" ? m.splitBy : null,
    splitIndex: m.kind === "SPLIT" ? m.splitIndex : null,
    splitRegex: m.kind === "SPLIT" ? m.splitRegex : null,
    constantValue: m.kind === "CONSTANT" ? m.constantValue : null,
    expression: m.kind === "EXPRESSION" ? m.expression : null,
    ticks: m.kind === "TICKS" ? (m.ticks ?? DEFAULT_TICK_RULES) : null,
    inputs: (m.kind === "CONSTANT" ? [] : m.inputs).map((i) => (m.kind === "TICKS" ? i : { ...i, tickValue: null })),
  };
}

/** A repeated group whose contents already repeat, e.g. `(\d+)+` or `(a*)*`: the shape behind catastrophic backtracking. */
export const NESTED_REPEAT = /\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*[+*{]/u;

export function splitPatternProblem(pattern: string): string | null {
  try {
    new RegExp(pattern, "u");
  } catch {
    return "The split pattern isn't a valid regular expression.";
  }
  if (NESTED_REPEAT.test(pattern)) {
    return "The split pattern repeats a group that already repeats, such as (\\d+)+, which can take very long to match. Simplify it.";
  }
  const groups = (new RegExp(`${pattern}|`, "u").exec("")?.length ?? 1) - 1;
  return groups < 1 ? "The split pattern needs a capture group in brackets, such as (\\d+)." : null;
}

/** What's wrong with a mapping's own settings, ignoring whether its fields still exist. */
export function mappingShapeProblem(m: MappingShape): string | null {
  const n = m.inputs.length;
  switch (m.kind) {
    case "COPY":
      return n === 1 ? null : "Copy reads exactly one field.";
    case "CONCAT":
      return n >= 1 ? null : "Choose at least one field to join.";
    case "SPLIT":
      if (n !== 1) return "Split reads exactly one field.";
      if (m.splitRegex !== null && m.splitBy !== null) return "Split by a separator or by a pattern, not both.";
      if (m.splitRegex !== null) return splitPatternProblem(m.splitRegex);
      if (m.splitBy === null || m.splitBy === "") return "Enter the separator to split on.";
      return m.splitIndex === null || m.splitIndex < 0 ? "Choose which part to keep." : null;
    case "CONSTANT":
      if (m.constantValue === null) return "Enter the value to fill in.";
      return n === 0 ? null : "A fixed value doesn't read any fields.";
    case "EXPRESSION": {
      if (m.expression === null) return "Write an expression.";
      const parsed = parseExpression(m.expression);
      if (!parsed.ok) return parsed.problem;
      const inputs = new Set(m.inputs.map((i) => i.fieldId));
      return parsed.value.refs.every((r) => inputs.has(r)) ? null : "The expression reads a field that isn't one of its inputs.";
    }
    case "TICKS":
      if (n === 0) return "Choose the tick fields to read.";
      return new Set(m.inputs.map((i) => i.fieldId)).size === n ? null : "Each tick field can only be listed once.";
  }
}

/**
 * What stops a From ticks mapping from giving an answer, given the fields it reads: every one must be
 * a Mark / tick field, and at least two must be read by the AI or typed (a Skip field is never ticked).
 */
export function ticksProblem(inputs: MappingSource[], fields: SourceFields): string | null {
  const read = inputs.flatMap((i) => fields.byId.get(i.fieldId) ?? []);
  const nonMark = read.find((f) => f.dataType !== "MARK");
  if (nonMark) return `“${nonMark.labelSource}” has the type ${FIELD_TYPE_LABELS[nonMark.dataType]}. From ticks can only read Mark / tick fields.`;
  const options = read.filter(isTickOption).length;
  return options < 2 ? `From ticks needs at least 2 Mark / tick fields set to Extract or Manual. This one has ${options}.` : null;
}

/** Why a source can't be read any more, or null. */
export function sourceProblem(source: MappingSource, fields: SourceFields, deletedFieldLabels?: ReadonlyMap<string, string>): string | null {
  if (fields.byId.has(source.fieldId)) return null;
  const label = deletedFieldLabels?.get(source.fieldId);
  return label ? `It reads “${label}”, which was deleted.` : "It reads a field that was deleted.";
}

export type MappingContext = {
  fields: SourceFields;
  liveColumnIds: ReadonlySet<string>;
  deletedFieldLabels?: ReadonlyMap<string, string>;
};

/** Why a mapping is BROKEN (docs/02 invariant 8), or null when it works. */
export function mappingProblem(m: TransformMapping, ctx: MappingContext): string | null {
  if (!ctx.liveColumnIds.has(m.outputColumnId)) return "Its output column was deleted.";
  for (const source of m.inputs) {
    const problem = sourceProblem(source, ctx.fields, ctx.deletedFieldLabels);
    if (problem) return problem;
  }
  return mappingShapeProblem(m) ?? (m.kind === "TICKS" ? ticksProblem(m.inputs, ctx.fields) : null);
}
