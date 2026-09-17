import { z } from "zod";

/**
 * Document-level review flags raised while building rows (docs/03 §8 steps 2–4), stored on
 * `Document.transformFlags`. Client-safe: the documents list and drawer show them as chips.
 */

export const DOCUMENT_FLAG_KINDS = [
  "SEQUENCE_GAP",
  "SEQUENCE_REPEAT",
  "SEQUENCE_ORDER",
  "SEQUENCE_UNREADABLE",
  "SUSPECTED_DUPLICATES",
  "UNRESOLVED_DITTO",
  "CELLS_FLAGGED",
  "ORPHANED_ROWS",
  "BUILD_FAILED",
] as const;

export type DocumentFlagKind = (typeof DOCUMENT_FLAG_KINDS)[number];

export const documentFlagSchema = z.object({ kind: z.enum(DOCUMENT_FLAG_KINDS), message: z.string() });

export type DocumentFlag = z.infer<typeof documentFlagSchema>;

export const DOCUMENT_FLAG_CHIPS: Record<DocumentFlagKind, string> = {
  SEQUENCE_GAP: "sequence gap",
  SEQUENCE_REPEAT: "sequence repeat",
  SEQUENCE_ORDER: "sequence out of order",
  SEQUENCE_UNREADABLE: "unreadable row numbers",
  SUSPECTED_DUPLICATES: "possible duplicate rows",
  UNRESOLVED_DITTO: "ditto with nothing above",
  CELLS_FLAGGED: "flagged cells",
  ORPHANED_ROWS: "unmatched edited rows",
  BUILD_FAILED: "rows not rebuilt",
};

/** Stored flags, or none when the column is empty or unreadable. */
export function parseDocumentFlags(value: unknown): DocumentFlag[] {
  const parsed = z.array(documentFlagSchema).safeParse(value);
  return parsed.success ? parsed.data : [];
}
