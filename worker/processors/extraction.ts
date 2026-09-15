import type { Job, Worker } from "bullmq";

import { processDocumentExtraction, RetryLater } from "@/lib/extraction/process";
import { JOBS } from "@/lib/queue";
import { parseInput } from "@/lib/validation";

/** How long the whole extraction queue pauses after the provider keeps answering "rate limited". */
const RATE_LIMIT_PAUSE_MS = 60_000;

/**
 * Routes `extraction` queue jobs. A transient failure puts the runs back and rethrows so BullMQ
 * retries with backoff; a rate limit also pauses the queue so other documents back off too (docs/06
 * Risks). The last attempt marks the runs FAILED, which the user can retry.
 */
export function createExtractionProcessor(getWorker: () => Worker | undefined) {
  return async (job: Job): Promise<unknown> => {
    if (job.name !== JOBS.extractionRun.name) throw new Error(`Unknown extraction job: ${job.name}`);
    const { documentId } = parseInput(JOBS.extractionRun.schema, job.data);
    const isLastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    try {
      return await processDocumentExtraction(documentId, { isLastAttempt });
    } catch (err) {
      if (err instanceof RetryLater && err.rateLimited) await getWorker()?.rateLimit(RATE_LIMIT_PAUSE_MS);
      throw err;
    }
  };
}
