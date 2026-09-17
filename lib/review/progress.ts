import type { TableRow } from "@/lib/table/types";

import type { ReviewProgress } from "./types";

/**
 * Row review order and progress over rows the browser holds. Pure and client-safe. Counts the same cells as the
 * table readout and `reviewProgress` on the server: rows that aren't void, cells of live columns.
 */

export type ReviewOrder = {
  /** Rows to review, in manual order. */
  rows: TableRow[];
  indexOf: Map<string, number>;
  /** Documents in the order their first row appears. */
  documents: string[];
  /** Row ids per document, in manual order. */
  rowsOf: Map<string, string[]>;
};

export function reviewOrder(rows: TableRow[]): ReviewOrder {
  const live = rows.filter((r) => !r.isVoid);
  const rowsOf = new Map<string, string[]>();
  for (const r of live) {
    const list = rowsOf.get(r.documentId);
    if (list) list.push(r.id);
    else rowsOf.set(r.documentId, [r.id]);
  }
  return { rows: live, indexOf: new Map(live.map((r, i) => [r.id, i])), documents: [...rowsOf.keys()], rowsOf };
}

export function progressOf(order: ReviewOrder, columnIds: string[]): ReviewProgress {
  let cells = 0;
  let reviewedCells = 0;
  const openDocuments = new Set<string>();
  for (const row of order.rows) {
    for (const id of columnIds) {
      const cell = row.cells[id];
      if (!cell) continue;
      cells++;
      if (cell.isReviewed) reviewedCells++;
      else openDocuments.add(row.documentId);
    }
  }
  return { cells, reviewedCells, documents: order.documents.length, reviewedDocuments: order.documents.length - openDocuments.size };
}

/** The first column of the row not yet reviewed, or 0 when every cell is. */
export function firstUnreviewedColumn(row: TableRow, columnIds: string[]): number {
  const i = columnIds.findIndex((id) => row.cells[id] && !row.cells[id].isReviewed);
  return i < 0 ? 0 : i;
}

/** The next row, after `fromIndex` and wrapping around, with an unreviewed cell; null when there is none. */
export function nextUnreviewedRow(order: ReviewOrder, columnIds: string[], fromIndex: number): number | null {
  const n = order.rows.length;
  for (let step = 1; step <= n; step++) {
    const i = (fromIndex + step) % n;
    const row = order.rows[i];
    if (row && columnIds.some((id) => row.cells[id] && !row.cells[id].isReviewed)) return i;
  }
  return null;
}
