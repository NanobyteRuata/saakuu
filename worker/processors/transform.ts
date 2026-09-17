import type { Job } from "bullmq";

import { log } from "@/lib/log";
import { JOBS, recordTemplateTransformRun, type TransformRunRecord } from "@/lib/queue";
import { prisma } from "@/lib/db/client";
import { transformDocument, transformTemplate } from "@/lib/transform/service";
import { revalidate } from "@/lib/validation/revalidate";
import { parseInput } from "@/lib/validation";

async function record(templateId: string, run: Omit<TransformRunRecord, "finishedAt">): Promise<void> {
  await recordTemplateTransformRun(templateId, { ...run, finishedAt: new Date().toISOString() }).catch((err: unknown) =>
    log.error("transform result not recorded", err, { templateId }),
  );
}

/**
 * Routes `transform` queue jobs: rebuild a template's rows (with progress) or one document's. No AI calls.
 * A template rebuild records its outcome, so the Mapping tab can say when documents failed; a rebuild in
 * which every document failed is retried, and its last attempt is recorded as failed.
 */
export async function processTransformJob(job: Job): Promise<unknown> {
  const isLastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
  switch (job.name) {
    case JOBS.transformTemplate.name: {
      const { templateId } = parseInput(JOBS.transformTemplate.schema, job.data);
      let result: Awaited<ReturnType<typeof transformTemplate>>;
      try {
        result = await transformTemplate(templateId, (progress) => job.updateProgress(progress));
      } catch (err) {
        if (isLastAttempt) await record(templateId, { documents: 0, failed: 0, error: "Rebuilding rows failed. Press Rebuild rows to try again." });
        throw err;
      }
      const allFailed = result.documents > 0 && result.failed === result.documents;
      if (allFailed && !isLastAttempt) throw new Error(`None of the ${result.documents} documents could be rebuilt; retrying.`);
      await record(templateId, {
        documents: result.documents,
        failed: result.failed,
        error: allFailed ? `None of the ${result.documents} documents could be rebuilt. Press Rebuild rows to try again.` : null,
      });
      return result;
    }
    case JOBS.transformDocument.name: {
      const { documentId } = parseInput(JOBS.transformDocument.schema, job.data);
      return transformDocument(documentId);
    }
    case JOBS.revalidateBook.name: {
      const { bookId } = parseInput(JOBS.revalidateBook.schema, job.data);
      const book = await prisma.book.findFirst({ where: { id: bookId, deletedAt: null }, select: { id: true } });
      if (!book) return { changed: 0 };
      const changes = await revalidate(prisma, bookId, { all: true });
      return { changed: changes.length };
    }
    default:
      throw new Error(`Unknown transform job: ${job.name}`);
  }
}
