import type { ValidationState, ValueState } from "@/lib/transform/types";

import type { Bbox, RowsPage, TableCell, TableDocument, TableRow } from "./types";

/**
 * Compact wire format for pages of rows. Defaults are left out and cells are listed in the page's
 * column order, so 3,000 rows of 20 columns stay small. Client-safe: the server encodes, the table decodes.
 */

const EDITED = 1;
const REVIEWED = 2;
const INHERITED = 4;
const DISAGREEMENT = 8;

export type WireCell = {
  i: string;
  /** Value; absent = null. */
  v?: string;
  /** State, when not what the value implies (OK with a value, EMPTY without). */
  s?: ValueState;
  /** Extracted value, when different from the value. */
  x?: string | null;
  /** Extracted state, when different from the state. */
  xs?: ValueState;
  f?: number;
  c?: number;
  /** Validation: 1 warning, 2 error, with messages. */
  e?: 1 | 2;
  m?: string[];
};

export type WireRow = { i: string; d: string; p: string; vd?: 1; vr?: string; ph?: string; bb?: Bbox; c: (WireCell | 0)[] };

export type WirePage = { columnIds: string[]; items: WireRow[]; documents: TableDocument[]; nextCursor: string | null };

export function encodeCell(cell: TableCell): WireCell {
  const w: WireCell = { i: cell.id };
  if (cell.value !== null) w.v = cell.value;
  if (cell.state !== (cell.value === null ? "EMPTY" : "OK")) w.s = cell.state;
  if (cell.extractedValue !== cell.value) w.x = cell.extractedValue;
  if (cell.extractedState !== cell.state) w.xs = cell.extractedState;
  const f = (cell.isEdited ? EDITED : 0) | (cell.isReviewed ? REVIEWED : 0) | (cell.inherited ? INHERITED : 0) | (cell.disagreement ? DISAGREEMENT : 0);
  if (f !== 0) w.f = f;
  if (cell.confidence !== null) w.c = cell.confidence;
  if (cell.validationState !== "NONE") {
    w.e = cell.validationState === "ERROR" ? 2 : 1;
    w.m = cell.validationMsgs;
  }
  return w;
}

export function decodeCell(w: WireCell, columnId: string): TableCell {
  const value = w.v ?? null;
  const state = w.s ?? (value === null ? "EMPTY" : "OK");
  const f = w.f ?? 0;
  const validationState: ValidationState = w.e === 2 ? "ERROR" : w.e === 1 ? "WARNING" : "NONE";
  return {
    id: w.i,
    columnId,
    value,
    state,
    extractedValue: w.x === undefined ? value : w.x,
    extractedState: w.xs ?? state,
    isEdited: (f & EDITED) !== 0,
    isReviewed: (f & REVIEWED) !== 0,
    inherited: (f & INHERITED) !== 0,
    disagreement: (f & DISAGREEMENT) !== 0,
    confidence: w.c ?? null,
    validationState,
    validationMsgs: w.m ?? [],
  };
}

export function encodeRow(row: TableRow, columnIds: string[]): WireRow {
  const w: WireRow = { i: row.id, d: row.documentId, p: row.position, c: columnIds.map((id) => (row.cells[id] ? encodeCell(row.cells[id]) : 0)) };
  if (row.isVoid) w.vd = 1;
  if (row.voidReason !== null) w.vr = row.voidReason;
  if (row.photoId !== null) w.ph = row.photoId;
  if (row.bbox !== null) w.bb = row.bbox;
  return w;
}

export function decodePage(page: WirePage): RowsPage {
  return {
    documents: page.documents,
    nextCursor: page.nextCursor,
    items: page.items.map((w) => {
      const cells: Record<string, TableCell> = {};
      w.c.forEach((c, i) => {
        const columnId = page.columnIds[i];
        if (c !== 0 && columnId !== undefined) cells[columnId] = decodeCell(c, columnId);
      });
      return {
        id: w.i,
        documentId: w.d,
        position: w.p,
        isVoid: w.vd === 1,
        voidReason: w.vr ?? null,
        photoId: w.ph ?? null,
        bbox: w.bb ?? null,
        cells,
      };
    }),
  };
}
