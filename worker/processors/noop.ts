import { hostname } from "node:os";

import type { Job } from "bullmq";

import { prisma } from "@/lib/db/client";
import { log } from "@/lib/log";
import { JOBS, type NoopJobResult } from "@/lib/queue/jobs";
import { parseInput } from "@/lib/validation";

/** No-op job: validates its payload, touches the DB, and returns. Used for smoke tests. */
export async function processNoop(job: Job): Promise<NoopJobResult> {
  const data = parseInput(JOBS.noop.schema, job.data);
  await prisma.$queryRaw`SELECT 1`;
  const result: NoopJobResult = {
    echo: data.echo ?? null,
    dbOk: true,
    worker: { hostname: hostname(), pid: process.pid },
    completedAt: new Date().toISOString(),
  };
  log.info("noop job processed", { jobId: job.id, requestedBy: data.requestedBy });
  return result;
}
