import { Queue, QueueEvents } from "bullmq";

import { createRedisConnection } from "./connection";
import { JOBS, QUEUES, type NoopJobData, type NoopJobResult, type QueueName } from "./jobs";

export { JOBS, QUEUES, createRedisConnection };
export type { NoopJobData, NoopJobResult, QueueName };

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
