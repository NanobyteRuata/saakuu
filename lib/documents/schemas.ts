import { z } from "zod";

import { confirmSchema, idListSchema, idSchema, labelSchema, PAGE_LIMIT_DEFAULT, PAGE_LIMIT_MAX } from "@/lib/validation";

export const RUN_STATES = ["NEVER_RUN", "QUEUED", "RUNNING", "PARTIAL", "FAILED", "COMPLETE"] as const;
export type RunState = (typeof RUN_STATES)[number];

/** A run is on its way or under way: the document's pages must not change under it. */
export const ACTIVE_RUN_STATES: RunState[] = ["QUEUED", "RUNNING"];

export const CONTENT_STATES = ["UNKNOWN", "HAS_CONTENT", "EMPTY", "NO_ROWS_FOUND"] as const;
export type ContentState = (typeof CONTENT_STATES)[number];

const booleanParam = z.enum(["true", "false"]).transform((v) => v === "true");

export const listDocumentsSchema = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(PAGE_LIMIT_MAX).default(PAGE_LIMIT_DEFAULT),
  templateId: idSchema.optional(),
  runState: z.enum(RUN_STATES).optional(),
  needsReview: booleanParam.optional(),
  hasEdits: booleanParam.optional(),
  reviewed: booleanParam.optional(),
  /** Phase 11: a page was transformed, replaced or added after the last successful reading. */
  needsReextraction: booleanParam.optional(),
  q: z.string().trim().max(200).optional(),
});
export type ListDocumentsInput = z.infer<typeof listDocumentsSchema>;

/** A document can hold at most this many pages; keeps extraction requests and the drawer bounded. */
export const MAX_DOCUMENT_PAGES = 200;

const photoIdsSchema = z.array(idSchema).min(1).max(MAX_DOCUMENT_PAGES);

export const groupPhotosSchema = z.object({ photoIds: photoIdsSchema });
export type GroupPhotosInput = z.infer<typeof groupPhotosSchema>;

export const splitDocumentSchema = z.object({ photoIds: photoIdsSchema });
export type SplitDocumentInput = z.infer<typeof splitDocumentSchema>;

export const reorderPhotosSchema = z.object({ photoIds: photoIdsSchema });
export type ReorderPhotosInput = z.infer<typeof reorderPhotosSchema>;

/** A MANUAL value is stored exactly as typed; `null` clears it. */
export const MAX_MANUAL_VALUE_LENGTH = 2000;

export const updateDocumentSchema = z
  .object({
    label: labelSchema.optional(),
    manualValues: z.record(idSchema, z.string().max(MAX_MANUAL_VALUE_LENGTH).nullable()).optional(),
    /**
     * Phase 15: clearing the flag promotes a specimen to an ordinary document (decision 71). Its
     * rows were always built, so this is a flag flip — no re-extraction, no rebuild.
     */
    isSpecimen: z.boolean().optional(),
  })
  .refine((v) => v.label !== undefined || v.manualValues !== undefined || v.isSpecimen !== undefined, "Nothing to update.");
export type UpdateDocumentInput = z.infer<typeof updateDocumentSchema>;

const impactHashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

export const documentsImpactSchema = z.object({ ids: idListSchema });

export const deleteDocumentsSchema = z.object({ ids: idListSchema, impactHash: impactHashSchema, confirm: confirmSchema });
export type DeleteDocumentsInput = z.infer<typeof deleteDocumentsSchema>;

export const moveImpactSchema = z.object({ ids: idListSchema, targetTemplateId: idSchema });
export type MoveImpactInput = z.infer<typeof moveImpactSchema>;

export const moveDocumentsSchema = moveImpactSchema.extend({ impactHash: impactHashSchema, confirm: confirmSchema });
export type MoveDocumentsInput = z.infer<typeof moveDocumentsSchema>;
