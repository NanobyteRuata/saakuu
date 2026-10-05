import { z } from "zod";

import { confirmSchema, idListSchema, idSchema, labelSchema, PAGE_LIMIT_DEFAULT, PAGE_LIMIT_MAX } from "@/lib/validation";

import { nonceSchema } from "@/lib/extraction/schemas";

import { DOCUMENT_STATUSES } from "./status";

export const RUN_STATES = ["NEVER_RUN", "QUEUED", "RUNNING", "PARTIAL", "FAILED", "COMPLETE"] as const;
export type RunState = (typeof RUN_STATES)[number];

/** A run is on its way or under way: the document's pages must not change under it. */
export const ACTIVE_RUN_STATES: RunState[] = ["QUEUED", "RUNNING"];

export const CONTENT_STATES = ["UNKNOWN", "HAS_CONTENT", "EMPTY", "NO_ROWS_FOUND"] as const;
export type ContentState = (typeof CONTENT_STATES)[number];

/** Book order is the documents' own `position`; the other two sort by upload time (Phase 18). */
export const DOCUMENT_SORTS = ["book", "newest", "oldest"] as const;
export type DocumentSort = (typeof DOCUMENT_SORTS)[number];

function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * The viewer's IANA time zone, so "uploaded on 2026-09-21" means their day rather than UTC's — a batch
 * shot at 6am in Yangon (UTC+6:30) is still the previous day in UTC. An unknown zone falls back to UTC
 * rather than failing.
 */
export const timeZoneSchema = z
  .string()
  .max(64)
  .regex(/^[A-Za-z0-9_+\-/]+$/)
  .refine(isTimeZone)
  .catch("UTC");

export const isoDaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { error: "Use a date like 2026-09-21." });

export const listDocumentsSchema = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(PAGE_LIMIT_MAX).default(PAGE_LIMIT_DEFAULT),
  templateId: idSchema.optional(),
  /** Phase 18: one named state in place of the run-state select and the four tri-states. */
  status: z.enum(DOCUMENT_STATUSES).optional(),
  /** Phase 18: documents uploaded on this day, in `tz`. */
  uploadedOn: isoDaySchema.optional(),
  sort: z.enum(DOCUMENT_SORTS).default("book"),
  tz: timeZoneSchema,
  q: z.string().trim().max(200).optional(),
});
export type ListDocumentsInput = z.infer<typeof listDocumentsSchema>;

export const uploadDaysSchema = z.object({ tz: timeZoneSchema, templateId: idSchema.optional() });
export type UploadDaysInput = z.infer<typeof uploadDaysSchema>;

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
  })
  .refine((v) => v.label !== undefined || v.manualValues !== undefined, "Nothing to update.");
export type UpdateDocumentInput = z.infer<typeof updateDocumentSchema>;

const impactHashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

/** Decision 78: a specimen is added to the documents as a copy; the template keeps its reference page. */
export const promoteSpecimenSchema = z.object({ impactHash: impactHashSchema, nonce: nonceSchema });
export type PromoteSpecimenInput = z.infer<typeof promoteSpecimenSchema>;

export const documentsImpactSchema = z.object({ ids: idListSchema });

export const deleteDocumentsSchema = z.object({ ids: idListSchema, impactHash: impactHashSchema, confirm: confirmSchema });
export type DeleteDocumentsInput = z.infer<typeof deleteDocumentsSchema>;

export const moveImpactSchema = z.object({ ids: idListSchema, targetTemplateId: idSchema });
export type MoveImpactInput = z.infer<typeof moveImpactSchema>;

export const moveDocumentsSchema = moveImpactSchema.extend({ impactHash: impactHashSchema, confirm: confirmSchema });
export type MoveDocumentsInput = z.infer<typeof moveDocumentsSchema>;
