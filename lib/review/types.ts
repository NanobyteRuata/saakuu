import type { Bbox } from "@/lib/table/types";

import type { CellSource } from "./sources";

/** Row review as the browser holds it (docs/05 §13). Client-safe. */

export type RowSources = {
  rowId: string;
  /** The page the row was read from, and the row's box on it. */
  photoId: string | null;
  bbox: Bbox | null;
  /** By column id; columns no working mapping fills are absent. */
  cells: Record<string, CellSource>;
};

export type ReviewProgress = { cells: number; reviewedCells: number; documents: number; reviewedDocuments: number };

export type ReviewQueuePage = {
  items: { rowId: string; documentId: string; unreviewedCellIds: string[] }[];
  nextCursor: string | null;
  progress: ReviewProgress;
};
