import { loadDotEnv, getEnv } from "@/lib/env";

loadDotEnv();

import "@/lib/log-context-node";

import { Worker, type Job } from "bullmq";

import { prisma } from "@/lib/db/client";
import { log } from "@/lib/log";
import { withLogContext } from "@/lib/log-context";
import { JOBS, QUEUES, closeQueues, createRedisConnection, scheduleMaintenance } from "@/lib/queue";

import { createExtractionProcessor } from "./processors/extraction";
import { processMediaJob } from "./processors/media";
import { processSystemJob } from "./processors/system";
import { processTransformJob } from "./processors/transform";

/** Runs a processor with the job's ids on every log line it writes, including the enqueuing request's id. */
function traced(processor: (job: Job) => Promise<unknown>): (job: Job) => Promise<unknown> {
  return (job) => {
    const data: unknown = job.data;
    const correlationId =
      typeof data === "object" && data !== null && "correlationId" in data && typeof data.correlationId === "string"
        ? data.correlationId
        : undefined;
    return withLogContext({ jobId: job.id, queue: job.queueName, jobName: job.name, correlationId }, () => processor(job));
  };
}

/** Rebuilds are cheap database work; two at once, and the book lock serialises them within a book. */
const TRANSFORM_CONCURRENCY = 2;

async function main(): Promise<void> {
  const env = getEnv();
  await prisma.$connect();

  // The processor reads the worker lazily (to pause the queue on rate limits), after construction.
  const extractionWorker: Worker = new Worker(QUEUES.extraction, traced(createExtractionProcessor(() => extractionWorker)), {
    connection: createRedisConnection(),
    concurrency: env.EXTRACTION_CONCURRENCY,
    // One job is one document; most documents are one model call. Keeps free-tier RPM in check.
    limiter: { max: env.EXTRACTION_RPM, duration: 60_000 },
  });

  const workers = [
    new Worker(QUEUES.system, traced(processSystemJob), {
      connection: createRedisConnection(),
      concurrency: env.WORKER_CONCURRENCY,
    }),
    new Worker(QUEUES.media, traced(processMediaJob), {
      connection: createRedisConnection(),
      concurrency: env.MEDIA_CONCURRENCY,
    }),
    extractionWorker,
    new Worker(QUEUES.transform, traced(processTransformJob), {
      connection: createRedisConnection(),
      concurrency: TRANSFORM_CONCURRENCY,
    }),
  ];

  for (const worker of workers) {
    worker.on("ready", () => log.info("worker ready", { queue: worker.name }));
    // The reaper runs every minute; its start/finish lines would drown everything else. It logs when it acts.
    const quiet = (job: Job) => job.name === JOBS.reapStale.name;
    worker.on("active", (job) => {
      if (!quiet(job)) log.info("job started", { queue: worker.name, jobId: job.id, name: job.name, correlationId: job.data?.correlationId });
    });
    worker.on("completed", (job) => {
      if (!quiet(job)) log.info("job completed", { queue: worker.name, jobId: job.id, name: job.name, correlationId: job.data?.correlationId });
    });
    worker.on("failed", (job, err) =>
      log.error("job failed", err, { queue: worker.name, jobId: job?.id, name: job?.name }),
    );
    worker.on("error", (err) => log.error("worker error", err, { queue: worker.name }));
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("worker shutting down", { signal });
    await Promise.allSettled(workers.map((w) => w.close()));
    await closeQueues();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await scheduleMaintenance();

  log.info("worker started", { queues: workers.map((w) => w.name), concurrency: env.WORKER_CONCURRENCY });
}

main().catch((err: unknown) => {
  log.error("worker failed to start", err);
  process.exit(1);
});
