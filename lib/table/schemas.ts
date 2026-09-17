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

export const reviewCellsSchema = z
  .object({ cellIds: z.array(idSchema).max(5000).optional(), rowIds: z.array(idSchema).max(500).optional(), isReviewed: z.boolean() })
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
