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

export type ColumnCounts = { errors: number; unreviewed: number };

export type TableCounts = { cells: number; unreviewed: number; errors: number; byColumn: Map<string, ColumnCounts> };

/** Counts over rows that count: not void. Deleted rows never reach the browser. */
export function countCells(rows: TableRow[], columnIds: string[]): TableCounts {
  const byColumn = new Map<string, ColumnCounts>(columnIds.map((id) => [id, { errors: 0, unreviewed: 0 }]));
  let cells = 0;
  let unreviewed = 0;
  let errors = 0;
  for (const row of rows) {
    if (row.isVoid) continue;
    for (const id of columnIds) {
      const cell = row.cells[id];
      const counts = byColumn.get(id);
      if (!cell || !counts) continue;
      cells++;
      if (!cell.isReviewed) {
        unreviewed++;
        counts.unreviewed++;
      }
      if (cell.validationState === "ERROR") {
        errors++;
        counts.errors++;
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
