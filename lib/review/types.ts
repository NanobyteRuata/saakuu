import type { ReviewSource } from "@/lib/table/schemas";
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

/**
 * Where review stopped (Phase 19): the first row with an unreviewed cell at or after the row holding the book's most
 * recently reviewed cell. Null when nothing is reviewed yet, or nothing is left.
 */
export type ResumePoint = { rowId: string; documentId: string; documentLabel: string | null };

/**
 * Seconds per reviewed cell, per review source (Phase 19, decision 57). `timedCells` are the cells whose review
 * followed another within `breakSeconds`; `seconds` is the time they took. Never blended across sources.
 */
export type ReviewPace = {
  sources: { via: ReviewSource; cells: number; timedCells: number; seconds: number }[];
  breakSeconds: number;
};
