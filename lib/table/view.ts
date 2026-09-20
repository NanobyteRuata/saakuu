import type { ColumnType } from "@/lib/books/schemas";

import type { CellValidationUpdate, TableCell, TableRow } from "./types";

/**
 * View-only state for the output table: filters, sorting and counts. Nothing here writes; manual row order
 * stays canonical (docs/02 invariant 6). Client-safe and pure.
 */

export type ColumnFilter =
  | { kind: "errors" | "warnings" | "attention" | "edited" | "unreviewed" | "empty" }
  | { kind: "contains"; text: string };

export type ToolbarFilter = {
  attention: boolean;
  errors: boolean;
  edited: boolean;
  templateId: string | null;
  showVoid: boolean;
};

export const NO_TOOLBAR_FILTER: ToolbarFilter = { attention: false, errors: false, edited: false, templateId: null, showVoid: true };

export function isToolbarFiltered(f: ToolbarFilter): boolean {
  return f.attention || f.errors || f.edited || f.templateId !== null || !f.showVoid;
}

function needsAttention(cell: TableCell): boolean {
  return cell.validationState !== "NONE" || cell.disagreement;
}

export function matchesToolbar(row: TableRow, f: ToolbarFilter, templateOf: (documentId: string) => string | undefined): boolean {
  if (!f.showVoid && row.isVoid) return false;
  if (f.templateId !== null && templateOf(row.documentId) !== f.templateId) return false;
  const cells = Object.values(row.cells);
  if (f.attention && !cells.some(needsAttention)) return false;
  if (f.errors && !cells.some((c) => c.validationState === "ERROR")) return false;
  if (f.edited && !cells.some((c) => c.isEdited)) return false;
  return true;
}

export function matchesColumnFilter(cell: TableCell | undefined, f: ColumnFilter): boolean {
  if (!cell) return false;
  switch (f.kind) {
    case "errors":
      return cell.validationState === "ERROR";
    case "warnings":
      return cell.validationState === "WARNING";
    case "attention":
      return needsAttention(cell);
    case "edited":
      return cell.isEdited;
    case "unreviewed":
      return !cell.isReviewed;
    case "empty":
      return cell.value === null && cell.state === "EMPTY";
    case "contains":
      return (cell.value ?? "").toLocaleLowerCase().includes(f.text.toLocaleLowerCase());
  }
}

/** Sort order for one column's cells. Values that aren't the column's type sort after those that are; blanks last. */
export function compareCells(a: TableCell | undefined, b: TableCell | undefined, type: ColumnType): number {
  const av = a?.value ?? null;
  const bv = b?.value ?? null;
  if (av === null || bv === null) return av === bv ? 0 : av === null ? 1 : -1;
  if (type === "NUMBER" || type === "INTEGER") {
    const an = Number(av);
    const bn = Number(bv);
    const aOk = av.trim() !== "" && Number.isFinite(an);
    const bOk = bv.trim() !== "" && Number.isFinite(bn);
    if (aOk && bOk) return an - bn;
    if (aOk !== bOk) return aOk ? -1 : 1;
  }
  return av.localeCompare(bv);
}

export type ColumnCounts = { errors: number; unreviewed: number; unparsed: number };

export type TableCounts = { cells: number; unreviewed: number; errors: number; byColumn: Map<string, ColumnCounts> };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const NUMERIC = /^-?\d+(\.\d+)?$/u;

/** Column types whose values are converted, so a whole column of them can fail on one book setting. */
export const CONVERTED_TYPES = new Set<ColumnType>(["DATE", "NUMBER", "INTEGER"]);

/**
 * A value the transform kept as written because it would not coerce to the column's type. Coercion never
 * discards data (lib/transform/coerce.ts), so a flagged cell still holding text the type would not accept
 * is a parse failure rather than a rule failure. Read structurally rather than by matching the message,
 * so rewording an error can never silently turn the column's era offer off (decision 76).
 *
 * Edited cells don't count. The offer asks a question about the paper, and one operator mistyping a date
 * is not evidence about the paper — it would raise "is this paper using the Myanmar era?" over their own
 * slip. Only what the machine read can answer that.
 */
export function isUnparsed(cell: TableCell, dataType: ColumnType): boolean {
  if (cell.validationState !== "ERROR" || cell.isEdited || !cell.value) return false;
  if (dataType === "DATE") return !ISO_DATE.test(cell.value);
  if (dataType === "NUMBER" || dataType === "INTEGER") return !NUMERIC.test(cell.value);
  return false;
}

/** One column's unparsed count, for watching a rebuild land without recounting the whole table. */
export function countUnparsed(rows: TableRow[], columnId: string, dataType: ColumnType): number {
  let n = 0;
  for (const row of rows) {
    if (row.isVoid) continue;
    const cell = row.cells[columnId];
    if (cell && isUnparsed(cell, dataType)) n++;
  }
  return n;
}

/** Counts over rows that count: not void. Deleted rows never reach the browser. */
export function countCells(rows: TableRow[], columns: { id: string; dataType: ColumnType }[]): TableCounts {
  const byColumn = new Map<string, ColumnCounts>(columns.map((c) => [c.id, { errors: 0, unreviewed: 0, unparsed: 0 }]));
  let cells = 0;
  let unreviewed = 0;
  let errors = 0;
  for (const row of rows) {
    if (row.isVoid) continue;
    for (const column of columns) {
      const cell = row.cells[column.id];
      const counts = byColumn.get(column.id);
      if (!cell || !counts) continue;
      cells++;
      if (!cell.isReviewed) {
        unreviewed++;
        counts.unreviewed++;
      }
      if (cell.validationState === "ERROR") {
        errors++;
        counts.errors++;
        if (isUnparsed(cell, column.dataType)) counts.unparsed++;
      }
    }
  }
  return { cells, unreviewed, errors, byColumn };
}

/** The rows with one cell replaced. */
export function withCell(rows: TableRow[], rowId: string, cell: TableCell): TableRow[] {
  const i = rows.findIndex((r) => r.id === rowId);
  const row = rows[i];
  if (!row) return rows;
  const next = rows.slice();
  next[i] = { ...row, cells: { ...row.cells, [cell.columnId]: cell } };
  return next;
}

/** The rows with validation results of other cells applied (uniqueness, increasing order, cross-column). */
export function withValidation(rows: TableRow[], updates: CellValidationUpdate[]): TableRow[] {
  if (updates.length === 0) return rows;
  const byRow = new Map<string, CellValidationUpdate[]>();
  for (const u of updates) byRow.set(u.rowId, [...(byRow.get(u.rowId) ?? []), u]);
  return rows.map((row) => {
    const list = byRow.get(row.id);
    if (!list) return row;
    const cells = { ...row.cells };
    for (const u of list) {
      const entry = Object.entries(cells).find(([, c]) => c.id === u.id);
      if (entry) cells[entry[0]] = { ...entry[1], validationState: u.validationState, validationMsgs: u.validationMsgs };
    }
    return { ...row, cells };
  });
}
