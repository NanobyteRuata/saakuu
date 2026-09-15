import { UnrecoverableError, type Job } from "bullmq";

import { ingestPhoto, isUserFacingError, markPhotoFailed, markRenderFailed, renderPhoto } from "@/lib/photos/process";
import { JOBS } from "@/lib/queue";
import { parseInput } from "@/lib/validation";

/**
 * Routes `media` queue jobs.
 * - Ingest: a problem with the file itself (unreadable, too many PDF pages) fails at once without
 *   retries; anything else is retried and the last attempt marks the photo FAILED.
 * - Render: a failure never fails the photo. The original and upright copy are fine, so the photo
 *   stays editable; the error is recorded and a new save retries the render.
 */
export async function processMediaJob(job: Job): Promise<unknown> {
  const isLastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
  switch (job.name) {
    case JOBS.photoIngest.name: {
      const { photoId } = parseInput(JOBS.photoIngest.schema, job.data);
      try {
        return await ingestPhoto(photoId);
      } catch (err) {
        if (isUserFacingError(err)) {
          await markPhotoFailed(photoId, err);
          throw new UnrecoverableError(err.message);
        }
        if (isLastAttempt) await markPhotoFailed(photoId, err);
        throw err;
      }
    }
    case JOBS.photoRender.name: {
      const { photoId } = parseInput(JOBS.photoRender.schema, job.data);
      try {
        return await renderPhoto(photoId);
      } catch (err) {
        if (isUserFacingError(err) || isLastAttempt) {
          await markRenderFailed(photoId, err);
          if (isUserFacingError(err)) throw new UnrecoverableError(err.message);
        }
        throw err;
      }
    }
    default:
      throw new Error(`Unknown media job: ${job.name}`);
  }
}
