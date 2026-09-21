import type { Job, Worker } from "bullmq";

import { processDocumentExtraction, RetryLater } from "@/lib/extraction/process";
import { JOBS } from "@/lib/queue";
import { processFieldProposal } from "@/lib/templates/field-proposal-process";
import { parseInput } from "@/lib/validation";

/** How long the whole extraction queue pauses after the provider keeps answering "rate limited". */
const RATE_LIMIT_PAUSE_MS = 60_000;

/**
 * Routes `extraction` queue jobs: document extraction and template proposals (Phase 16), which spend
 * the same key and so share the queue's concurrency and its rate-limit pause. A transient failure puts the runs back and rethrows so BullMQ
 * retries with backoff; a rate limit also pauses the queue so other documents back off too (docs/06
 * Risks). The last attempt marks the runs FAILED, which the user can retry.
 */
export function createExtractionProcessor(getWorker: () => Worker | undefined) {
  return async (job: Job): Promise<unknown> => {
    const isLastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    try {
      if (job.name === JOBS.fieldProposal.name) {
        const { proposalId } = parseInput(JOBS.fieldProposal.schema, job.data);
        return await processFieldProposal(proposalId, { isLastAttempt });
      }
      if (job.name !== JOBS.extractionRun.name) throw new Error(`Unknown extraction job: ${job.name}`);
      const { documentId } = parseInput(JOBS.extractionRun.schema, job.data);
      return await processDocumentExtraction(documentId, { isLastAttempt });
    } catch (err) {
      if (err instanceof RetryLater && err.rateLimited) await getWorker()?.rateLimit(RATE_LIMIT_PAUSE_MS);
      throw err;
    }
  };
}
