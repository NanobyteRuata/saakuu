import { Queue, QueueEvents } from "bullmq";

import { createRedisConnection } from "./connection";
import {
  JOBS,
  QUEUES,
  type ExtractionRunJobData,
  type NoopJobData,
  type NoopJobResult,
  type PhotoIngestJobData,
  type PhotoRenderJobData,
  type QueueName,
} from "./jobs";

export { JOBS, QUEUES, createRedisConnection };
export type { ExtractionRunJobData, NoopJobData, NoopJobResult, PhotoIngestJobData, PhotoRenderJobData, QueueName };

/** Retries cover worker restarts, storage hiccups and rate limits the provider retry didn't outlast. */
export const EXTRACTION_JOB_ATTEMPTS = 4;

/**
 * Enqueues extraction for a document. There is one job id per document, so enqueueing while its job
 * is waiting, backing off before a retry, or running does nothing: that job picks up every queued run,
 * and its attempt count and backoff are kept. A finished job with the id is removed first, so new runs
 * get a fresh job.
 */
export async function enqueueExtraction(data: ExtractionRunJobData): Promise<"added" | "pending"> {
  const payload = JOBS.extractionRun.schema.parse(data);
  const queue = getQueue(JOBS.extractionRun.queue);
  const jobId = `extract-${payload.documentId}`;
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

const MEDIA_JOB_OPTIONS = { attempts: 3, backoff: { type: "exponential", delay: 2000 } } as const;

/** Enqueues ingest once per photo: the job id is the photo id, so a repeated complete is a no-op. */
export async function enqueuePhotoIngest(data: PhotoIngestJobData): Promise<void> {
  const payload = JOBS.photoIngest.schema.parse(data);
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
  const payload = JOBS.photoRender.schema.parse(data);
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

const globalForQueues = globalThis as unknown as { saakuuQueues?: Map<QueueName, Queue> };
const queues = (globalForQueues.saakuuQueues ??= new Map<QueueName, Queue>());

/** One Queue instance per name per process. */
export function getQueue(name: QueueName): Queue {
  let queue = queues.get(name);
  if (!queue) {
    queue = new Queue(name, {
      connection: createRedisConnection(),
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    });
    queues.set(name, queue);
  }
  return queue;
}

export async function enqueueNoop(data: NoopJobData): Promise<string> {
  const payload = JOBS.noop.schema.parse(data);
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

export async function closeQueues(): Promise<void> {
  await Promise.all([...queues.values()].map((q) => q.close()));
  queues.clear();
}
