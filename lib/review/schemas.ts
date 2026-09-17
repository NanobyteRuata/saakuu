import { z } from "zod";

/** Row review input schemas (docs/04 → Review). Client-safe. */

export const REVIEW_QUEUE_MAX = 500;

export const reviewQueueSchema = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(REVIEW_QUEUE_MAX).default(50),
});
export type ReviewQueueInput = z.infer<typeof reviewQueueSchema>;
