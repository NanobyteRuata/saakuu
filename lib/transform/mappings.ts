import { ancestorsFrom, selectionProblem, type Tree } from "@/lib/templates/tree";

import { parseExpression } from "./expression";
import type { MappingSource, TransformField, TransformGroup, TransformMapping } from "./types";

/**
 * Mapping rules (docs/01 §6.5b, docs/03 §8 step 6). Pure: the save-time check, broken-mapping
 * detection and the transform all use these, so they can't disagree about what works.
 */

export type SourceTree = Tree<TransformGroup, TransformField>;

export type MappingShape = Omit<TransformMapping, "id" | "outputColumnId">;

export const DEFAULT_SEPARATOR = ", ";
/** Ticked options of an Any of group are joined with this. */
export const OPTION_SEPARATOR = ", ";

export function sourceId(source: MappingSource): string | null {
  return source.kind === "field" ? source.fieldId : source.kind === "group" ? source.groupId : null;
}

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
    inputs: m.kind === "CONSTANT" ? [] : m.inputs,
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
      return n === 1 ? null : "Copy reads exactly one field or tick group.";
    case "CONCAT":
      return n >= 1 ? null : "Choose at least one field to join.";
    case "SPLIT":
      if (n !== 1) return "Split reads exactly one field.";
      if (m.inputs[0]?.kind === "group") return "Split reads a field, not a tick group.";
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
      const inputs = new Set(m.inputs.map(sourceId));
      return parsed.value.refs.every((r) => inputs.has(r)) ? null : "The expression reads a field that isn't one of its inputs.";
    }
  }
}

/** Why a source can't be read any more, or null. */
export function sourceProblem(source: MappingSource, tree: SourceTree, deletedFieldLabels?: ReadonlyMap<string, string>): string | null {
  if (source.kind === "missing") return "It reads a tick group that was deleted.";
  if (source.kind === "field") {
    if (tree.fields.has(source.fieldId)) return null;
    const label = deletedFieldLabels?.get(source.fieldId);
    return label ? `It reads “${label}”, which was deleted.` : "It reads a field that was deleted.";
  }
  const node = tree.groups.get(source.groupId);
  if (!node) return "It reads a tick group that was deleted.";
  if (node.group.selection === "NONE") {
    return `“${node.group.labelSource}” is a header only, so it has no single answer. Set it to One of or Any of, or map its columns one by one.`;
  }
  return selectionProblem(tree, source.groupId);
}

export type MappingContext = {
  tree: SourceTree;
  liveColumnIds: ReadonlySet<string>;
  deletedFieldLabels?: ReadonlyMap<string, string>;
};

/** Why a mapping is BROKEN (docs/02 invariant 8), or null when it works. */
export function mappingProblem(m: TransformMapping, ctx: MappingContext): string | null {
  if (!ctx.liveColumnIds.has(m.outputColumnId)) return "Its output column was deleted.";
  for (const source of m.inputs) {
    const problem = sourceProblem(source, ctx.tree, ctx.deletedFieldLabels);
    if (problem) return problem;
  }
  return mappingShapeProblem(m);
}

/**
 * An option's default output: its path below the selection group, meaning labels where set
 * (`Positive › A`). A mapping can replace it with its own value per option.
 */
export function optionLabel(tree: SourceTree, groupId: string, fieldId: string): string {
  const node = tree.fields.get(fieldId);
  if (!node) return "";
  const chain: string[] = [];
  for (const g of ancestorsFrom(tree, node.parentId)) {
    if (g.id === groupId) break;
    chain.unshift(g.group.labelMeaning ?? g.group.labelSource);
  }
  chain.push(node.field.labelMeaning ?? node.field.labelSource);
  return chain.join(" › ");
}
