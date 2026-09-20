import { z } from "zod";

import { impactHashSchema } from "@/lib/books/schemas";
import { confirmSchema, idListSchema, idSchema } from "@/lib/validation";

import { VALUE_STATES } from "./edits";

/** Output table input schemas (docs/04 → Output table). Client-safe. */

export const ROWS_PAGE_MAX = 500;
export const MAX_CELL_VALUE_LENGTH = 5000;

export const listRowsSchema = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(ROWS_PAGE_MAX).default(ROWS_PAGE_MAX),
});
export type ListRowsInput = z.infer<typeof listRowsSchema>;

export const editCellSchema = z.object({
  /** Blank clears the cell. */
  value: z.string().max(MAX_CELL_VALUE_LENGTH).nullable(),
  /** Marks the cell as unreadable, a dash or not applicable instead of a value. Default OK. */
  state: z.enum(VALUE_STATES).optional(),
  /** The edit this save continues: saves of one editing session undo as one step. */
  editId: idSchema.optional(),
});
export type EditCellInput = z.infer<typeof editCellSchema>;

/**
 * How a cell came to be reviewed (Phase 12, decision 57). A row-level mark stamps every cell of the
 * row at one instant; averaged together with per-cell confirms, any later "seconds per cell" figure
 * is fiction. Deciding it at collection time is free; discovering it later is not.
 */
export const REVIEW_SOURCES = ["CELL", "ROW", "ILLEGIBLE"] as const;
export type ReviewSource = (typeof REVIEW_SOURCES)[number];

const reviewTargetSchema = z.object({
  cellIds: z.array(idSchema).max(5000).optional(),
  rowIds: z.array(idSchema).max(500).optional(),
});

/**
 * A union rather than an optional `via`, so the *compiler* enforces what the schema enforces: marking
 * cells reviewed without saying how is unrepresentable. With `via` merely optional, an internal caller
 * (the seed script, a future job) could pass `{ isReviewed: true }`, Prisma would skip the undefined
 * field, and the cell would get a fresh `reviewedAt` beside a stale `reviewedVia` — silently wrong
 * timing data in the one phase that exists to collect it.
 */
export const reviewCellsSchema = z
  .discriminatedUnion("isReviewed", [
    reviewTargetSchema.extend({ isReviewed: z.literal(true), via: z.enum(REVIEW_SOURCES) }),
    /** Clearing a mark has no source to record: both columns go back to null. */
    reviewTargetSchema.extend({ isReviewed: z.literal(false) }),
  ])
  .refine((v) => (v.cellIds?.length ?? 0) + (v.rowIds?.length ?? 0) > 0, "Choose cells or rows.");
export type ReviewCellsInput = z.infer<typeof reviewCellsSchema>;

export const reorderRowSchema = z.object({
  rowId: idSchema,
  /** The row it now follows in manual order; null = first. */
  afterRowId: idSchema.nullable(),
});
export type ReorderRowInput = z.infer<typeof reorderRowSchema>;

export const updateRowSchema = z.object({ isVoid: z.boolean() });
export type UpdateRowInput = z.infer<typeof updateRowSchema>;

export const rowsImpactSchema = z.object({ ids: idListSchema });

export const rowsActionSchema = z.object({ ids: idListSchema, impactHash: impactHashSchema, confirm: confirmSchema });
export type RowsActionInput = z.infer<typeof rowsActionSchema>;
