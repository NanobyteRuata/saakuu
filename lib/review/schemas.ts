import { z } from "zod";

import { idSchema } from "@/lib/validation";

/** Row review input schemas (docs/04 → Review). Client-safe. */

export const REVIEW_QUEUE_MAX = 500;

export const reviewQueueSchema = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(REVIEW_QUEUE_MAX).default(50),
});
export type ReviewQueueInput = z.infer<typeof reviewQueueSchema>;

export const COLUMN_SOURCES_MAX = 500;

export const columnSourcesSchema = z.object({
  columnId: idSchema,
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(COLUMN_SOURCES_MAX).default(COLUMN_SOURCES_MAX),
});
export type ColumnSourcesInput = z.infer<typeof columnSourcesSchema>;
