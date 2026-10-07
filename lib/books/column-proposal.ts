import { MAX_COLUMNS, type ColumnType } from "@/lib/books/schemas";
import { slugifyKey } from "@/lib/books/slug";
import type { SourceFields } from "@/lib/templates/source-fields";
import type { FieldView } from "@/lib/templates/views";

/**
 * `Create columns from this template` (docs/06 Phase 10, decision 52). The app proposes one output
 * column per field the template reads that no mapping reads yet; the human renames and prunes. Pure:
 * the preview the operator confirms and the write that follows both come from here, so the counts agree.
 *
 * Every tick field gets its own yes/no column. Which ticks belong together as one answer is not
 * guessed: the operator combines them with a From ticks mapping (decision 84).
 */

export type ProposedColumn = {
  fieldId: string;
  /** The field's name, as it reads on the paper: `RDT Test › Positive › A`. */
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
  fields: SourceFields;
  /** Fields this template's mappings already read. */
  mappedFieldIds: ReadonlySet<string>;
  /** Every key in the book, including soft-deleted columns: the unique index ignores `deletedAt`. */
  takenKeys: Iterable<string>;
  /** Columns the book already has, so a proposal can't push it past the limit. */
  liveColumns: number;
};

/** One column per unmapped field, in paper order. Extract-mode fields only: Manual and Skip fields are not what the AI reads. */
export function proposeColumns({ fields, mappedFieldIds, takenKeys, liveColumns }: ProposalInput): ProposedColumn[] {
  const taken = new Set(takenKeys);
  const items: ProposedColumn[] = [];
  for (const field of fields.list) {
    if (field.mode !== "EXTRACT" || mappedFieldIds.has(field.id)) continue;
    if (liveColumns + items.length >= MAX_COLUMNS) break;
    const label = columnLabel(field.labelSource, field.labelMeaning);
    const key = slugifyKey(label, taken, items.length + 1);
    taken.add(key);
    items.push({ fieldId: field.id, sourcePath: field.labelSource, label, key, ...fieldColumnType(field) });
  }
  return items;
}
