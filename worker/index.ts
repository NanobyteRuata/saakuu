import { loadDotEnv, getEnv } from "@/lib/env";

loadDotEnv();

import { Worker } from "bullmq";

import { prisma } from "@/lib/db/client";
import { log } from "@/lib/log";
import { QUEUES, closeQueues, createRedisConnection } from "@/lib/queue";

import { processSystemJob } from "./processors/system";

async function main(): Promise<void> {
  const env = getEnv();
  await prisma.$connect();

  const workers = [
    new Worker(QUEUES.system, processSystemJob, {
      connection: createRedisConnection(),
      concurrency: env.WORKER_CONCURRENCY,
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
