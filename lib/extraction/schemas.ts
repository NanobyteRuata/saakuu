import { z } from "zod";

import { modelIdSchema } from "@/lib/ai/models";
import { idListSchema, idSchema, PAGE_LIMIT_DEFAULT, PAGE_LIMIT_MAX } from "@/lib/validation";

/** Extraction input schemas. Client-safe: the extract dialog and the handlers share them. */

/** Below this share of anchors seen, a document is flagged as a possible template mismatch. */
export const MISMATCH_THRESHOLD = 0.5;

/** Documents a template-wide extract can cover in one action. */
export const MAX_TEMPLATE_EXTRACT_DOCUMENTS = 2000;

const exactlyOneTarget = (v: { documentIds?: string[]; templateId?: string }) =>
  (v.documentIds !== undefined) !== (v.templateId !== undefined);

/** Generated once per extract action in the browser and reused, so a double submit is one run. */
export const nonceSchema = z.string().regex(/^[A-Za-z0-9-]{16,100}$/, { error: "Reload the page and try again." });

export const estimateSchema = z
  .object({ documentIds: idListSchema.optional(), templateId: idSchema.optional(), model: modelIdSchema.optional() })
  .refine(exactlyOneTarget, { error: "Choose documents or a template to extract." });
export type EstimateInput = z.infer<typeof estimateSchema>;

export const startSchema = z
  .object({ documentIds: idListSchema.optional(), templateId: idSchema.optional(), model: modelIdSchema, nonce: nonceSchema })
  .refine(exactlyOneTarget, { error: "Choose documents or a template to extract." });
export type StartInput = z.infer<typeof startSchema>;

export const retrySchema = z
  .object({ documentIds: idListSchema.optional(), photoIds: z.array(idSchema).min(1).max(200).optional() })
  .refine((v) => (v.documentIds !== undefined) !== (v.photoIds !== undefined), { error: "Choose documents or pages to retry." });
export type RetryInput = z.infer<typeof retrySchema>;

export const statusQuerySchema = z.object({
  documentIds: z
    .string()
    .transform((s) => s.split(",").filter(Boolean))
    .pipe(z.array(idSchema).min(1).max(200)),
});

/**
 * The run drawer (Phase 18): one page of documents being read or read in the last day, or the one
 * document a row asked the drawer to open on.
 */
export const runActivitySchema = z.object({
  cursor: z.string().max(300).optional(),
  limit: z.coerce.number().int().min(1).max(PAGE_LIMIT_MAX).default(PAGE_LIMIT_DEFAULT),
  documentId: idSchema.optional(),
});
export type RunActivityInput = z.infer<typeof runActivitySchema>;
