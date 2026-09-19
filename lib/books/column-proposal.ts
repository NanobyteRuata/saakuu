import { MAX_COLUMNS, type ColumnType } from "@/lib/books/schemas";
import { slugifyKey } from "@/lib/books/slug";
import type { SourceTree } from "@/lib/templates/source-tree";
import { formatPath, headerPath, selectionOptions, selectionProblem, type SiblingRef } from "@/lib/templates/tree";
import type { FieldView } from "@/lib/templates/views";
import { optionLabel } from "@/lib/transform/mappings";

/**
 * `Create columns from this template` (docs/06 Phase 10, decision 52). The app proposes one output
 * column per source the template reads that no mapping fills yet; the human renames and prunes. Pure:
 * the preview the operator confirms and the write that follows both come from here, so the counts agree.
 *
 * A selection group is one answer, so it proposes one column mapped from the group — not one column
 * per tick box (docs/03 §8 step 5a).
 */

export type ProposedColumn = {
  source: SiblingRef;
  /** Where it comes from, as it reads on the paper: `RDT Test › Positive`. */
  sourcePath: string;
  label: string;
  key: string;
  dataType: ColumnType;
  enumValues: string[];
};

/** Labels are capped at 200 characters (`labelSchema`); a source label may be longer. */
const MAX_LABEL = 200;
const MAX_ENUM_VALUES = 200;
const MAX_ENUM_LENGTH = 200;

/** The list values a column can hold (`enumValuesSchema`, `columnShapeProblem`), or null to stay text. */
function usableEnumValues(values: string[]): string[] | null {
  if (values.length === 0 || values.length > MAX_ENUM_VALUES) return null;
  if (new Set(values).size !== values.length) return null;
  if (values.some((v) => v.trim().length === 0 || v.length > MAX_ENUM_LENGTH)) return null;
  return values;
}

type ColumnShape = { dataType: ColumnType; enumValues: string[] };

const TEXT: ColumnShape = { dataType: "TEXT", enumValues: [] };

/**
 * The column type a field's readings fit. AGE normalises to months and FRACTION to a number, and a
 * MARK field that counts its symbols reads as a number rather than a yes/no (`readMark`).
 */
export function fieldColumnType(field: Pick<FieldView, "dataType" | "choices" | "markSymbols">): ColumnShape {
  switch (field.dataType) {
    case "NUMBER":
    case "AGE":
    case "FRACTION":
      return { dataType: "NUMBER", enumValues: [] };
    case "INTEGER":
      return { dataType: "INTEGER", enumValues: [] };
    case "DATE":
      return { dataType: "DATE", enumValues: [] };
    case "MARK":
      return Object.values(field.markSymbols ?? {}).includes("count")
        ? { dataType: "INTEGER", enumValues: [] }
        : { dataType: "BOOLEAN", enumValues: [] };
    case "CHOICE": {
      const values = usableEnumValues(field.choices);
      return values ? { dataType: "ENUM", enumValues: values } : TEXT;
    }
    default:
      return TEXT;
  }
}

function columnLabel(source: string, meaning: string | null): string {
  return (meaning ?? source).slice(0, MAX_LABEL);
}

export type ProposalInput = {
  tree: SourceTree;
  /** Sources this template's mappings already read. */
  mappedFieldIds: ReadonlySet<string>;
  mappedGroupIds: ReadonlySet<string>;
  /** Every key in the book, including soft-deleted columns: the unique index ignores `deletedAt`. */
  takenKeys: Iterable<string>;
  /** Columns the book already has, so a proposal can't push it past the limit. */
  liveColumns: number;
};

/**
 * One column per unmapped source, in paper order. Extract-mode fields only — Manual and Skip fields
 * are not what the AI reads — and a selection group with its own problem is left alone until that is fixed.
 */
export function proposeColumns({ tree, mappedFieldIds, mappedGroupIds, takenKeys, liveColumns }: ProposalInput): ProposedColumn[] {
  const taken = new Set(takenKeys);
  const items: ProposedColumn[] = [];

  const add = (source: SiblingRef, label: string, shape: ColumnShape) => {
    if (liveColumns + items.length >= MAX_COLUMNS) return;
    const key = slugifyKey(label, taken, items.length + 1);
    taken.add(key);
    items.push({ source, sourcePath: formatPath(headerPath(tree, source)), label, key, ...shape });
  };

  const visit = (nodes: SourceTree["roots"]): void => {
    for (const node of nodes) {
      if (node.kind === "field") {
        const { field } = node;
        if (field.mode !== "EXTRACT" || mappedFieldIds.has(field.id)) continue;
        add({ kind: "field", id: field.id }, columnLabel(field.labelSource, field.labelMeaning), fieldColumnType(field));
        continue;
      }
      if (node.group.selection === "NONE") {
        visit(node.children);
        continue;
      }
      if (mappedGroupIds.has(node.id) || selectionProblem(tree, node.id) !== null) continue;
      // One of answers with a single option label; Any of joins several, so it stays text.
      const options = selectionOptions(node).map((f) => optionLabel(tree, node.id, f.id));
      const values = node.group.selection === "ONE_OF" ? usableEnumValues(options) : null;
      add(
        { kind: "group", id: node.id },
        columnLabel(node.group.labelSource, node.group.labelMeaning),
        values ? { dataType: "ENUM", enumValues: values } : TEXT,
      );
    }
  };

  visit(tree.roots);
  return items;
}
