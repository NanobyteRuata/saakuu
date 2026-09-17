import type { ValidationState, ValueState } from "@/lib/transform/types";

/**
 * The output table as the browser holds it (docs/05 §12). Client-safe. The wire format is compact
 * (lib/table/wire.ts): a few thousand rows × columns of full objects would be megabytes of repeated keys.
 */

export type TableCell = {
  id: string;
  columnId: string;
  value: string | null;
  state: ValueState;
  extractedValue: string | null;
  extractedState: ValueState;
  isEdited: boolean;
  isReviewed: boolean;
  inherited: boolean;
  disagreement: boolean;
  confidence: number | null;
  validationState: ValidationState;
  validationMsgs: string[];
};

export type Bbox = { x: number; y: number; w: number; h: number };

export type TableRow = {
  id: string;
  documentId: string;
  position: string;
  isVoid: boolean;
  voidReason: string | null;
  photoId: string | null;
  bbox: Bbox | null;
  /** By column id. Every live column has a cell (docs/02 invariant 5). */
  cells: Record<string, TableCell>;
};

export type TableDocument = { id: string; label: string | null; templateId: string; needsReview: boolean };

/** How a template fills a column, when that decides the cell's authorship (docs/08 §2). */
export type ColumnSource = "MANUAL" | "SKIP";

export type TableColumn = { id: string; key: string; label: string; dataType: import("@/lib/books/schemas").ColumnType; isRequired: boolean };

export type TableMeta = {
  bookId: string;
  columns: TableColumn[];
  templates: { id: string; name: string }[];
  /** templateId → columnId → source. */
  columnSources: Record<string, Record<string, ColumnSource>>;
  confidenceThreshold: number;
  totalRows: number;
};

export type RowsPage = {
  items: TableRow[];
  documents: TableDocument[];
  nextCursor: string | null;
};

/** A validation state another cell took as a result of a change (uniqueness, increasing order, cross-column). */
export type CellValidationUpdate = { id: string; rowId: string; validationState: ValidationState; validationMsgs: string[] };

export type CellChangeResult = {
  cell: TableCell;
  rowId: string;
  /** The log entry to undo; null when nothing changed. */
  editId: string | null;
  affected: CellValidationUpdate[];
};
