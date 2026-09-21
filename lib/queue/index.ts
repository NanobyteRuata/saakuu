import { Queue, QueueEvents } from "bullmq";
import type { Redis } from "ioredis";

import { log } from "@/lib/log";
import { currentCorrelationId } from "@/lib/log-context";

import { createProducerConnection, createRedisConnection } from "./connection";
import {
  JOBS,
  QUEUES,
  type ExtractionRunJobData,
  type FieldProposalJobData,
  type NoopJobData,
  type NoopJobResult,
  type PhotoIngestJobData,
  type PhotoRenderJobData,
  type QueueName,
  type RevalidateBookJobData,
  type TransformDocumentJobData,
  type TransformTemplateJobData,
} from "./jobs";

export { JOBS, QUEUES, createRedisConnection };
export type {
  ExtractionRunJobData,
  FieldProposalJobData,
  NoopJobData,
  NoopJobResult,
  PhotoIngestJobData,
  PhotoRenderJobData,
  QueueName,
  RevalidateBookJobData,
  TransformDocumentJobData,
  TransformTemplateJobData,
};

/** Stamps the enqueuing request's (or job's) id on the payload so the job's log lines can be traced back. */
function correlated<T extends { correlationId?: string }>(payload: T): T {
  const correlationId = payload.correlationId ?? currentCorrelationId();
  return correlationId ? { ...payload, correlationId } : payload;
}

const TRANSFORM_JOB_OPTIONS = { attempts: 3, backoff: { type: "exponential", delay: 5000 } } as const;

const templateTransformKey = (templateId: string) => `transform-template-${templateId}`;

/**
 * Enqueues a rebuild of a template's rows. Deduplicated per template: while one is waiting another
 * request does nothing (the job reads the latest mappings when it starts); while one is running, one
 * more is kept to run after it, so a change saved mid-run is never lost.
 */
export async function enqueueTemplateTransform(data: TransformTemplateJobData): Promise<void> {
  const payload = correlated(JOBS.transformTemplate.schema.parse(data));
  await getQueue(JOBS.transformTemplate.queue).add(JOBS.transformTemplate.name, payload, {
    ...TRANSFORM_JOB_OPTIONS,
    deduplication: { id: templateTransformKey(payload.templateId), keepLastIfActive: true },
  });
}

/** Enqueues a rebuild of one document's rows, deduplicated like a template rebuild. */
export async function enqueueDocumentTransform(data: TransformDocumentJobData): Promise<void> {
  const payload = correlated(JOBS.transformDocument.schema.parse(data));
  await getQueue(JOBS.transformDocument.queue).add(JOBS.transformDocument.name, payload, {
    ...TRANSFORM_JOB_OPTIONS,
    deduplication: { id: `transform-document-${payload.documentId}`, keepLastIfActive: true },
  });
}

const revalidateKey = (bookId: string) => `revalidate-book-${bookId}`;

/** Enqueues a re-check of a book's cells, deduplicated like a rebuild. */
export async function enqueueBookRevalidation(data: RevalidateBookJobData): Promise<void> {
  const payload = correlated(JOBS.revalidateBook.schema.parse(data));
  await getQueue(JOBS.revalidateBook.queue).add(JOBS.revalidateBook.name, payload, {
    ...TRANSFORM_JOB_OPTIONS,
    deduplication: { id: revalidateKey(payload.bookId), keepLastIfActive: true },
  });
}

/** Whether the book's re-check is waiting or running. */
export async function isBookRevalidationPending(bookId: string): Promise<boolean> {
  const queue = getQueue(QUEUES.transform);
  const jobId = await queue.getDeduplicationJobId(revalidateKey(bookId));
  const job = jobId ? await queue.getJob(jobId) : undefined;
  if (!job) return false;
  const state = await job.getState();
  return state !== "completed" && state !== "failed" && state !== "unknown";
}

export type TransformJobStatus = { running: boolean; progress: { done: number; total: number } | null };

function isProgress(value: unknown): value is { done: number; total: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    "done" in value &&
    "total" in value &&
    typeof value.done === "number" &&
    typeof value.total === "number"
  );
}

/** The template's pending or running rebuild, or null when there is none. */
export async function getTemplateTransformStatus(templateId: string): Promise<TransformJobStatus | null> {
  const queue = getQueue(QUEUES.transform);
  const jobId = await queue.getDeduplicationJobId(templateTransformKey(templateId));
  const job = jobId ? await queue.getJob(jobId) : undefined;
  if (!job) return null;
  const state = await job.getState();
  if (state === "completed" || state === "failed" || state === "unknown") return null;
  return { running: state === "active", progress: isProgress(job.progress) ? job.progress : null };
}

/** Retries cover worker restarts, storage hiccups and rate limits the provider retry didn't outlast. */
export const EXTRACTION_JOB_ATTEMPTS = 4;

/**
 * Enqueues extraction for a document. There is one job id per document, so enqueueing while its job
 * is waiting, backing off before a retry, or running does nothing: that job picks up every queued run,
 * and its attempt count and backoff are kept. A finished job with the id is removed first, so new runs
 * get a fresh job.
 */
export async function enqueueExtraction(data: ExtractionRunJobData): Promise<"added" | "pending"> {
  const payload = correlated(JOBS.extractionRun.schema.parse(data));
  const queue = getQueue(JOBS.extractionRun.queue);
  const jobId = extractionJobId(payload.documentId);
  const existing = await queue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (state !== "completed" && state !== "failed" && state !== "unknown") return "pending";
    await existing.remove();
  }
  await queue.add(JOBS.extractionRun.name, payload, {
    attempts: EXTRACTION_JOB_ATTEMPTS,
    backoff: { type: "exponential", delay: 15_000 },
    jobId,
  });
  return "added";
}

/**
 * Enqueues one template proposal (Phase 16). One job id per proposal, so re-enqueueing from the status
 * poll while it is waiting or running does nothing.
 */
export async function enqueueFieldProposal(data: FieldProposalJobData): Promise<"added" | "pending"> {
  const payload = correlated(JOBS.fieldProposal.schema.parse(data));
  const queue = getQueue(JOBS.fieldProposal.queue);
  const jobId = `propose-${payload.proposalId}`;
  const existing = await queue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (state !== "completed" && state !== "failed" && state !== "unknown") return "pending";
    await existing.remove();
  }
  await queue.add(JOBS.fieldProposal.name, payload, {
    attempts: EXTRACTION_JOB_ATTEMPTS,
    backoff: { type: "exponential", delay: 15_000 },
    jobId,
  });
  return "added";
}

const MEDIA_JOB_OPTIONS = { attempts: 3, backoff: { type: "exponential", delay: 2000 } } as const;

export type JobPresence = "active" | "pending" | "none";

/**
 * Whether a job with this id is running (`active`), waiting to run (`pending`: waiting, delayed,
 * prioritised, or backing off before a retry), or absent/finished (`none`).
 */
export async function jobPresence(queueName: QueueName, jobId: string): Promise<JobPresence> {
  const job = await getQueue(queueName).getJob(jobId);
  if (!job) return "none";
  const state = await job.getState();
  if (state === "active") return "active";
  return state === "completed" || state === "failed" || state === "unknown" ? "none" : "pending";
}

export const extractionJobId = (documentId: string) => `extract-${documentId}`;

/** Re-queues ingest for a photo whose earlier job finished without finishing the photo (e.g. the worker died). */
export async function requeuePhotoIngest(data: PhotoIngestJobData): Promise<void> {
  const payload = correlated(JOBS.photoIngest.schema.parse(data));
  const queue = getQueue(JOBS.photoIngest.queue);
  const jobId = `ingest-${payload.photoId}`;
  const previous = await queue.getJob(jobId);
  if (previous) {
    const state = await previous.getState();
    if (state !== "completed" && state !== "failed" && state !== "unknown") return;
    await previous.remove();
  }
  await queue.add(JOBS.photoIngest.name, payload, { ...MEDIA_JOB_OPTIONS, jobId });
}

/** Enqueues ingest once per photo: the job id is the photo id, so a repeated complete is a no-op. */
export async function enqueuePhotoIngest(data: PhotoIngestJobData): Promise<void> {
  const payload = correlated(JOBS.photoIngest.schema.parse(data));
  await getQueue(JOBS.photoIngest.queue).add(JOBS.photoIngest.name, payload, {
    ...MEDIA_JOB_OPTIONS,
    jobId: `ingest-${payload.photoId}`,
  });
}

/**
 * Enqueues a render keyed by photo and transform hash, so saving the same transform twice renders
 * once. The processor re-reads the current transform and drops stale results.
 */
export async function enqueuePhotoRender(data: PhotoRenderJobData, transformHash: string): Promise<void> {
  const payload = correlated(JOBS.photoRender.schema.parse(data));
  const queue = getQueue(JOBS.photoRender.queue);
  const jobId = `render-${payload.photoId}-${transformHash}`;
  // A failed job keeps its id for a week and would swallow the retry; clear it so the render runs again.
  const previous = await queue.getJob(jobId);
  if (previous && (await previous.isFailed())) await previous.remove();
  await queue.add(JOBS.photoRender.name, payload, { ...MEDIA_JOB_OPTIONS, jobId });
}

const DEFAULT_JOB_OPTIONS = {
  removeOnComplete: { age: 24 * 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600 },
} as const;

type QueueEntry = { queue: Queue; connection: Redis };

const globalForQueues = globalThis as unknown as { saakuuProducerQueues?: Map<QueueName, QueueEntry> };
const queues = (globalForQueues.saakuuProducerQueues ??= new Map<QueueName, QueueEntry>());

/**
 * One Queue instance per name per process, on a fail-fast producer connection. A connection that gave
 * up reconnecting is replaced, so a Redis restart doesn't leave the process unable to enqueue.
 */
export function getQueue(name: QueueName): Queue {
  const entry = queues.get(name);
  if (entry && entry.connection.status !== "end") return entry.queue;
  // Deliberately not awaited: `discardQueue` removes the entry before its first await, so the new one below stands.
  if (entry) void discardQueue(name);
  const connection = createProducerConnection();
  const queue = new Queue(name, { connection, defaultJobOptions: DEFAULT_JOB_OPTIONS });
  queue.on("error", (err) => log.warn("queue connection error", { queue: name, error: err.message }));
  queues.set(name, { queue, connection });
  return queue;
}

/** Drops a queue and its connection (BullMQ doesn't close connections it was given); the next use reconnects. */
export async function discardQueue(name: QueueName): Promise<void> {
  const entry = queues.get(name);
  if (!entry) return;
  queues.delete(name);
  await entry.queue.close().catch(() => undefined);
  entry.connection.disconnect();
}

/** The outcome of a template's last finished rebuild, kept for a week so the Mapping tab can report failures. */
export type TransformRunRecord = { documents: number; failed: number; error: string | null; finishedAt: string };

const lastRunKey = (templateId: string) => `saakuu:transform:last:${templateId}`;

function isRunRecord(value: unknown): value is TransformRunRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    "documents" in value &&
    typeof value.documents === "number" &&
    "failed" in value &&
    typeof value.failed === "number" &&
    "error" in value &&
    (value.error === null || typeof value.error === "string") &&
    "finishedAt" in value &&
    typeof value.finishedAt === "string"
  );
}

/**
 * A queue's own producer connection, once ready, for small bookkeeping keys next to its jobs (BullMQ's client
 * interface doesn't expose plain commands like expiring sets or counters).
 */
export async function queueConnection(name: QueueName): Promise<Redis> {
  await getQueue(name).client;
  const entry = queues.get(name);
  if (!entry) throw new Error(`${name} queue connection missing`);
  return entry.connection;
}

export async function recordTemplateTransformRun(templateId: string, record: TransformRunRecord): Promise<void> {
  const connection = await queueConnection(QUEUES.transform);
  await connection.set(lastRunKey(templateId), JSON.stringify(record), "EX", 7 * 24 * 3600);
}

export async function getLastTemplateTransformRun(templateId: string): Promise<TransformRunRecord | null> {
  const connection = await queueConnection(QUEUES.transform);
  const raw = await connection.get(lastRunKey(templateId));
  if (raw === null) return null;
  const value: unknown = JSON.parse(raw);
  return isRunRecord(value) ? value : null;
}

export async function enqueueNoop(data: NoopJobData): Promise<string> {
  const payload = correlated(JOBS.noop.schema.parse(data));
  const job = await getQueue(JOBS.noop.queue).add(JOBS.noop.name, payload);
  if (!job.id) {
    throw new Error("BullMQ did not assign a job id");
  }
  return job.id;
}

/**
 * Enqueues a no-op job and waits for a worker to complete it.
 * Used by the queue health check and `pnpm job:noop` to prove the pipeline end to end.
 */
export async function runNoopRoundTrip(
  data: NoopJobData,
  timeoutMs = 15_000,
): Promise<{ jobId: string; result: NoopJobResult }> {
  const events = new QueueEvents(JOBS.noop.queue, { connection: createRedisConnection() });
  try {
    await events.waitUntilReady();
    const queue = getQueue(JOBS.noop.queue);
    const job = await queue.add(JOBS.noop.name, JOBS.noop.schema.parse(data));
    if (!job.id) {
      throw new Error("BullMQ did not assign a job id");
    }
    const result = (await job.waitUntilFinished(events, timeoutMs)) as NoopJobResult;
    return { jobId: job.id, result };
  } finally {
    await events.close();
  }
}

/** How often the reaper runs, and when the daily storage cleanup runs (03:30 UTC, away from working hours in Myanmar). */
export const REAP_EVERY_MS = 60_000;
export const STORAGE_CLEANUP_CRON = "30 3 * * *";

/**
 * Registers the maintenance schedules. Idempotent: every worker calls it at start, and a scheduler id
 * holds one schedule however many workers upsert it.
 */
export async function scheduleMaintenance(): Promise<void> {
  const queue = getQueue(QUEUES.system);
  await queue.upsertJobScheduler("reap-stale", { every: REAP_EVERY_MS }, { name: JOBS.reapStale.name, data: {} });
  await queue.upsertJobScheduler("storage-cleanup", { pattern: STORAGE_CLEANUP_CRON, tz: "UTC" }, { name: JOBS.storageCleanup.name, data: {} });
}

export async function closeQueues(): Promise<void> {
  await Promise.all([...queues.keys()].map((name) => discardQueue(name)));
}
