import { z } from "zod";

import { impactHashSchema } from "@/lib/books/schemas";
import { MAPPING_KINDS } from "@/lib/transform/types";
import { confirmSchema, idSchema } from "@/lib/validation";

/** Mapping input schemas (docs/04 → Mappings). Client-safe: shared by the Mapping tab and the handlers. */

export const MAX_MAPPINGS = 500;
export const MAX_MAPPING_INPUTS = 50;

/** A field, or a selection group resolved to its answer with optional per-option output values. */
export const mappingSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("field"), id: idSchema }),
  z.object({
    kind: z.literal("group"),
    id: idSchema,
    optionValues: z.record(z.string().max(64), z.string().max(200, { error: "Keep option values to 200 characters or fewer." })).default({}),
    noneValue: z.string().max(200, { error: "Keep this value to 200 characters or fewer." }).nullable().default(null),
  }),
]);

export type MappingSourceInput = z.infer<typeof mappingSourceSchema>;

/**
 * A whole mapping. Create and update both take the full shape; options that don't belong to the kind
 * are cleared. For EXPRESSION the inputs are the `{id}` references in the expression (group inputs may
 * still carry their option values here).
 */
export const mappingDraftSchema = z.object({
  outputColumnId: idSchema,
  kind: z.enum(MAPPING_KINDS),
  inputs: z.array(mappingSourceSchema).max(MAX_MAPPING_INPUTS, { error: `A mapping can read up to ${MAX_MAPPING_INPUTS} fields.` }).default([]),
  separator: z.string().max(20, { error: "Keep the separator to 20 characters or fewer." }).nullable().default(null),
  splitBy: z.string().max(20, { error: "Keep the separator to 20 characters or fewer." }).nullable().default(null),
  splitIndex: z.number().int().min(0).max(99).nullable().default(null),
  splitRegex: z.string().max(200, { error: "Keep the pattern to 200 characters or fewer." }).nullable().default(null),
  constantValue: z.string().max(2000, { error: "Keep the value to 2,000 characters or fewer." }).nullable().default(null),
  expression: z.string().max(2000, { error: "Keep expressions to 2,000 characters or fewer." }).nullable().default(null),
  fillDown: z.boolean().default(true),
});

export type MappingDraft = z.infer<typeof mappingDraftSchema>;

export const deleteMappingSchema = z.object({ impactHash: impactHashSchema, confirm: confirmSchema });

export type DeleteMappingInput = z.infer<typeof deleteMappingSchema>;

/** Preview on a document (default: the most recently extracted), optionally with one unsaved mapping in place. */
export const previewMappingsSchema = z.object({
  documentId: idSchema.optional(),
  draft: mappingDraftSchema.extend({ id: idSchema.nullable().default(null) }).optional(),
});

export type PreviewMappingsInput = z.infer<typeof previewMappingsSchema>;
