import { z } from "zod";

import { exportTokenSchema } from "@/lib/books/schemas";
import { idSchema } from "@/lib/validation";

/** Export input schemas (docs/04 → Export). Client-safe. */

export const exportOptionsSchema = z.object({
  includeVoid: z.boolean().default(false),
  includeProvenance: z.boolean().default(false),
  /** Columns to export, in book order whatever order they are listed in; absent = every column. */
  columns: z.array(idSchema).min(1, { error: "Choose at least one column." }).max(200).optional(),
  /** Default to the book's export settings. */
  blankToken: exportTokenSchema.optional(),
  illegibleToken: exportTokenSchema.optional(),
});
export type ExportOptions = z.infer<typeof exportOptionsSchema>;

export const exportLinkSchema = z.string().min(20).max(12000).regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
