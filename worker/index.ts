import { loadDotEnv, getEnv } from "@/lib/env";

loadDotEnv();

import { Worker } from "bullmq";

import { prisma } from "@/lib/db/client";
import { log } from "@/lib/log";
import { QUEUES, closeQueues, createRedisConnection } from "@/lib/queue";

import { createExtractionProcessor } from "./processors/extraction";
import { processMediaJob } from "./processors/media";
import { processSystemJob } from "./processors/system";
import { processTransformJob } from "./processors/transform";

/** Rebuilds are cheap database work; two at once, and the book lock serialises them within a book. */
const TRANSFORM_CONCURRENCY = 2;

async function main(): Promise<void> {
  const env = getEnv();
  await prisma.$connect();

  // The processor reads the worker lazily (to pause the queue on rate limits), after construction.
  const extractionWorker: Worker = new Worker(QUEUES.extraction, createExtractionProcessor(() => extractionWorker), {
    connection: createRedisConnection(),
    concurrency: env.EXTRACTION_CONCURRENCY,
    // One job is one document; most documents are one model call. Keeps free-tier RPM in check.
    limiter: { max: env.EXTRACTION_RPM, duration: 60_000 },
  });

  const workers = [
    new Worker(QUEUES.system, processSystemJob, {
      connection: createRedisConnection(),
      concurrency: env.WORKER_CONCURRENCY,
    }),
    new Worker(QUEUES.media, processMediaJob, {
      connection: createRedisConnection(),
      concurrency: env.MEDIA_CONCURRENCY,
    }),
    extractionWorker,
    new Worker(QUEUES.transform, processTransformJob, {
      connection: createRedisConnection(),
      concurrency: TRANSFORM_CONCURRENCY,
    }),
  ];

  for (const worker of workers) {
    worker.on("ready", () => log.info("worker ready", { queue: worker.name }));
    worker.on("active", (job) => log.info("job started", { queue: worker.name, jobId: job.id, name: job.name }));
    worker.on("completed", (job) =>
      log.info("job completed", { queue: worker.name, jobId: job.id, name: job.name }),
    );
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

  log.info("worker started", { queues: workers.map((w) => w.name), concurrency: env.WORKER_CONCURRENCY });
}

main().catch((err: unknown) => {
  log.error("worker failed to start", err);
  process.exit(1);
});
