import { z } from "zod";

/**
 * Queue and job registry. Every job has a Zod payload schema that the enqueuer and
 * the processor both use, so a malformed job fails loudly instead of half-running.
 *
 * Queues are added here as phases land (e.g. `extraction` in Phase 5).
 */

export const QUEUES = {
  system: "system",
  media: "media",
  extraction: "extraction",
  transform: "transform",
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export const noopJobSchema = z.object({
  requestedBy: z.string().min(1).max(100),
  echo: z.string().max(500).optional(),
});

export type NoopJobData = z.infer<typeof noopJobSchema>;

export type NoopJobResult = {
  echo: string | null;
  dbOk: true;
  worker: { hostname: string; pid: number };
  completedAt: string;
};

/** Photo ingest: orient, convert HEIC, split PDFs, write base/working/thumbnail copies. */
export const photoIngestJobSchema = z.object({ photoId: z.string().min(1) });
export type PhotoIngestJobData = z.infer<typeof photoIngestJobSchema>;

/** Photo render: rebuild the working copy and thumbnail after a transform change. */
export const photoRenderJobSchema = z.object({ photoId: z.string().min(1) });
export type PhotoRenderJobData = z.infer<typeof photoRenderJobSchema>;

/** Extraction: every queued run of one document (docs/03 §7). */
export const extractionRunJobSchema = z.object({ documentId: z.string().min(1) });
export type ExtractionRunJobData = z.infer<typeof extractionRunJobSchema>;

/** Transform (docs/03 §8): rebuild rows from the raw layer for every extracted document of a template, at no AI cost. */
export const transformTemplateJobSchema = z.object({ templateId: z.string().min(1) });
export type TransformTemplateJobData = z.infer<typeof transformTemplateJobSchema>;

/** Transform one document, e.g. after its Manual values change. */
export const transformDocumentJobSchema = z.object({ documentId: z.string().min(1) });
export type TransformDocumentJobData = z.infer<typeof transformDocumentJobSchema>;

/** Revalidation (docs/01 §16): re-check every cell of a book against its rules, e.g. after columns change. */
export const revalidateBookJobSchema = z.object({ bookId: z.string().min(1) });
export type RevalidateBookJobData = z.infer<typeof revalidateBookJobSchema>;

export const JOBS = {
  noop: { queue: QUEUES.system, name: "noop", schema: noopJobSchema },
  photoIngest: { queue: QUEUES.media, name: "photo.ingest", schema: photoIngestJobSchema },
  photoRender: { queue: QUEUES.media, name: "photo.render", schema: photoRenderJobSchema },
  extractionRun: { queue: QUEUES.extraction, name: "extraction.run", schema: extractionRunJobSchema },
  transformTemplate: { queue: QUEUES.transform, name: "transform.template", schema: transformTemplateJobSchema },
  transformDocument: { queue: QUEUES.transform, name: "transform.document", schema: transformDocumentJobSchema },
  revalidateBook: { queue: QUEUES.transform, name: "validation.book", schema: revalidateBookJobSchema },
} as const;
