import type { Job } from "bullmq";

import { reapStale } from "@/lib/extraction/reaper";
import { JOBS } from "@/lib/queue/jobs";
import { runStorageCleanup } from "@/lib/storage/lifecycle";

import { processNoop } from "./noop";

/** Routes jobs on the `system` queue by name. Unknown names fail the job. */
export async function processSystemJob(job: Job): Promise<unknown> {
  switch (job.name) {
    case JOBS.noop.name:
      return processNoop(job);
    case JOBS.reapStale.name:
      return reapStale();
    case JOBS.storageCleanup.name:
      return runStorageCleanup();
    default:
      throw new Error(`Unknown job "${job.name}" on queue "${job.queueName}"`);
  }
}
