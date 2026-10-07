import { z } from "zod";

import { impactHashSchema } from "@/lib/books/schemas";
import { MULTIPLE_MARKED, NONE_MARKED, TICK_SELECTIONS } from "@/lib/templates/schemas";
import { MAPPING_KINDS } from "@/lib/transform/types";
import { confirmSchema, idSchema } from "@/lib/validation";

/** Mapping input schemas (docs/04 → Mappings). Client-safe: shared by the Mapping tab and the handlers. */

export const MAX_MAPPINGS = 500;
export const MAX_MAPPING_INPUTS = 50;

const tickText = z.string().max(200, { error: "Keep this to 200 characters or fewer." }).nullable().default(null);

/** One field a mapping reads. `tickValue` is for From ticks: what is written when this field is ticked. */
export const mappingSourceSchema = z.object({ id: idSchema, tickValue: tickText });

export type MappingSourceInput = z.infer<typeof mappingSourceSchema>;

/**
 * A whole mapping. Create and update both take the full shape; options that don't belong to the kind
 * are cleared. For EXPRESSION the inputs are the `{id}` references in the expression.
 */

/** From ticks: how the tick fields become one answer (docs/03 §8 step 5a). */
export const tickRulesSchema = z.object({
  selection: z.enum(TICK_SELECTIONS),
  noneMarked: z.enum(NONE_MARKED),
  multipleMarked: z.enum(MULTIPLE_MARKED),
  /** Written when nothing is ticked. */
  noneValue: tickText,
  /** The name warnings use; the column's label when left out. */
  label: tickText,
});

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
  ticks: tickRulesSchema.nullable().default(null),
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
