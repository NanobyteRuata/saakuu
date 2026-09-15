import { createId } from "@paralleldrive/cuid2";
import { Prisma } from "@prisma/client";

import { getProvider } from "@/lib/ai";
import { modelIdSchema } from "@/lib/ai/models";
import { ProviderError, providerErrorMessage, type Bbox, type ExtractionImage, type ExtractionResult, type ResponseLog } from "@/lib/ai/provider";
import { buildTemplateSnapshot } from "@/lib/ai/snapshot";
import { sortByPosition } from "@/lib/books/column-ops";
import { prisma } from "@/lib/db/client";
import { log } from "@/lib/log";
import { normalizeTransform, transformHash } from "@/lib/photos/transform";
import { workingKey } from "@/lib/storage/keys";
import { getObjectBuffer } from "@/lib/storage/s3";
import { MAX_FIELDS, MAX_GROUPS } from "@/lib/templates/schemas";
import { fieldSelect, groupSelect, toFieldView } from "@/lib/templates/views";

import { MAX_REQUEST_BYTES, RECORD_INDEX_PAGE_STRIDE, supersededRecordIds, type RunSummary } from "./plan";
import { recomputeDocumentRun } from "./service";

/**
 * Worker side of extraction (docs/03 §7). Claims the document's queued runs, calls the provider for
 * each, and writes each run's raw layer in one transaction. Rows and cells are Phase 6.
 */

/** A run left RUNNING this long belongs to a worker that died; it can be claimed again. */
const STALE_RUNNING_MS = 15 * 60_000;

/** A failure of this run's pages that retrying the job can't fix. */
class RunFailure extends Error {}

/** A transient failure: the claimed runs were put back and the job should be retried. */
export class RetryLater extends Error {
  readonly rateLimited: boolean;
  constructor(rateLimited: boolean, cause?: unknown) {
    super(rateLimited ? "The AI service is rate limiting; retrying later." : "Extraction hit a temporary problem; retrying later.", { cause });
    this.name = "RetryLater";
    this.rateLimited = rateLimited;
  }
}

type ClaimedRun = { id: string; model: string; photoIds: string[]; createdAt: Date };

function responsesJson(responses: ResponseLog[]): Prisma.InputJsonValue {
  return responses.map((r) => ({ attempt: r.attempt, text: r.text, issues: r.issues }));
}

async function failRun(
  runId: string,
  message: string,
  extra: { usage?: { inputTokens: number; outputTokens: number }; responses?: ResponseLog[] } = {},
): Promise<void> {
  await prisma.extractionRun.updateMany({
    where: { id: runId, state: "RUNNING" },
    data: {
      state: "FAILED",
      finishedAt: new Date(),
      error: message,
      inputTokens: extra.usage?.inputTokens ?? null,
      outputTokens: extra.usage?.outputTokens ?? null,
      rawResponse: extra.responses && extra.responses.length > 0 ? { responses: responsesJson(extra.responses) } : Prisma.DbNull,
    },
  });
}

async function loadImages(bookId: string, documentId: string, photoIds: string[]): Promise<ExtractionImage[]> {
  const photos = await prisma.photo.findMany({
    where: { id: { in: photoIds }, documentId },
    select: { id: true, pageIndex: true, status: true, transform: true, workingKey: true },
    take: photoIds.length,
  });
  const byId = new Map(photos.map((p) => [p.id, p]));
  const images: ExtractionImage[] = [];
  let bytes = 0;
  for (const id of photoIds) {
    const p = byId.get(id);
    if (!p) throw new RunFailure("The pages of this document changed after extraction started. Extract it again.");
    const expected = workingKey(bookId, p.id, transformHash(normalizeTransform(p.transform)));
    if (p.status !== "DONE" || p.workingKey !== expected) {
      throw new RunFailure(`Page ${p.pageIndex + 1} was edited after extraction started and its new copy isn't ready. Extract again in a moment.`);
    }
    const data = await getObjectBuffer(expected);
    bytes += data.length;
    images.push({ data, mimeType: "image/jpeg", pageIndex: p.pageIndex });
  }
  if (bytes > MAX_REQUEST_BYTES) throw new RunFailure("These pages are too large to send together (over 15 MB). Crop them or split the document.");
  return images;
}

function unionBbox(boxes: (Bbox | null)[]): Bbox | null {
  const real = boxes.filter((b): b is Bbox => b !== null);
  if (real.length === 0) return null;
  const x = Math.min(...real.map((b) => b.x));
  const y = Math.min(...real.map((b) => b.y));
  const right = Math.max(...real.map((b) => b.x + b.w));
  const bottom = Math.max(...real.map((b) => b.y + b.h));
  return { x, y, w: right - x, h: bottom - y };
}

/** One transaction: replace older records on these pages, insert this run's records, complete the run. */
async function writeRun(
  documentId: string,
  run: ClaimedRun,
  images: ExtractionImage[],
  result: ExtractionResult,
  sequenceFieldId: string | null,
): Promise<boolean> {
  const photoByPage = new Map(images.map((img, i) => [img.pageIndex, run.photoIds[i] ?? null]));
  const firstPage = Math.min(...images.map((i) => i.pageIndex));
  const records = result.records.map((r, i) => ({
    id: createId(),
    dto: r,
    recordIndex: firstPage * RECORD_INDEX_PAGE_STRIDE + i,
    photoId: photoByPage.get(r.pageIndex) ?? null,
  }));
  const summary: RunSummary = { contentState: result.contentState, anchorsFound: result.anchorsFound, records: records.length };

  return prisma.$transaction(
    async (tx) => {
      const locked = await tx.$queryRaw<{ state: string }[]>`SELECT state::text FROM "ExtractionRun" WHERE id = ${run.id} FOR UPDATE`;
      if (locked[0]?.state !== "RUNNING") return false;

      const existing = await tx.rawRecord.findMany({
        where: { documentId, runId: { not: run.id } },
        select: { id: true, runId: true, photoId: true, run: { select: { createdAt: true } } },
        take: 100_000,
      });
      const replaced = supersededRecordIds(
        existing.map((r) => ({ id: r.id, runId: r.runId, photoId: r.photoId, runCreatedAt: r.run.createdAt })),
        run,
      );
      if (replaced.length > 0) await tx.rawRecord.deleteMany({ where: { id: { in: replaced } } });

      if (records.length > 0) {
        await tx.rawRecord.createMany({
          data: records.map((r) => {
            const bbox = unionBbox(r.dto.values.map((v) => v.bbox));
            return {
              id: r.id,
              documentId,
              runId: run.id,
              recordIndex: r.recordIndex,
              rowType: r.dto.rowType,
              struckThrough: r.dto.struckThrough,
              sequenceValue: sequenceFieldId ? (r.dto.values.find((v) => v.fieldId === sequenceFieldId)?.valueText ?? null) : null,
              photoId: r.photoId,
              bbox: bbox ?? Prisma.DbNull,
            };
          }),
        });
        await tx.rawValue.createMany({
          data: records.flatMap((r) =>
            r.dto.values.map((v) => ({
              rawRecordId: r.id,
              fieldId: v.fieldId,
              valueText: v.valueText,
              altValueText: v.altValueText,
              state: v.state,
              isDitto: v.isDitto,
              confidence: v.confidence,
              photoId: r.photoId,
              bbox: v.bbox ?? Prisma.DbNull,
            })),
          ),
        });
      }

      await tx.extractionRun.update({
        where: { id: run.id },
        data: {
          state: "COMPLETE",
          finishedAt: new Date(),
          error: null,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          rawResponse: { summary, responses: responsesJson(result.rawResponse.responses) },
        },
      });
      await recomputeDocumentRun(tx, documentId);
      return true;
    },
    { timeout: 60_000 },
  );
}

export type ProcessOutcome = { status: "gone" | "idle" | "done"; completed: number; failed: number };

/** Most claim rounds per job; a round only repeats when runs were queued while the previous one worked. */
const MAX_CLAIM_ROUNDS = 10;

/**
 * Processes every queued run of the document. Runs queued while a round was working (a retry started as
 * the job was finishing, whose enqueue saw this job still active) are claimed by the next round, so they
 * aren't left waiting for the status poll to enqueue them.
 */
export async function processDocumentExtraction(documentId: string, opts: { isLastAttempt: boolean }): Promise<ProcessOutcome> {
  const total: ProcessOutcome = { status: "idle", completed: 0, failed: 0 };
  for (let round = 0; round < MAX_CLAIM_ROUNDS; round++) {
    const outcome = await processClaimRound(documentId, opts);
    if (outcome.status === "gone") return outcome;
    if (outcome.status === "idle") break;
    total.status = "done";
    total.completed += outcome.completed;
    total.failed += outcome.failed;
  }
  return total;
}

async function processClaimRound(documentId: string, opts: { isLastAttempt: boolean }): Promise<ProcessOutcome> {
  const doc = await prisma.document.findFirst({
    where: { id: documentId, deletedAt: null, template: { deletedAt: null }, book: { deletedAt: null } },
    select: {
      bookId: true,
      template: { select: { id: true, kind: true, languageHint: true, instructions: true, anchors: true, sequenceFieldId: true } },
      book: { select: { numeralSystem: true, dateEra: true } },
    },
  });
  if (!doc) {
    await prisma.extractionRun.updateMany({
      where: { documentId, state: { in: ["QUEUED", "RUNNING"] } },
      data: { state: "FAILED", finishedAt: new Date(), error: "The document was deleted before it was extracted." },
    });
    return { status: "gone", completed: 0, failed: 0 };
  }

  const claimed = await prisma.$queryRaw<ClaimedRun[]>`
    UPDATE "ExtractionRun" SET state = 'RUNNING'::"RunState", "startedAt" = now()
    WHERE "documentId" = ${documentId}
      AND (state = 'QUEUED'::"RunState" OR (state = 'RUNNING'::"RunState" AND "startedAt" < ${new Date(Date.now() - STALE_RUNNING_MS)}))
    RETURNING id, model, "photoIds", "createdAt"`;
  if (claimed.length === 0) return { status: "idle", completed: 0, failed: 0 };
  claimed.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  await prisma.$transaction((tx) => recomputeDocumentRun(tx, documentId));

  const [groups, fieldRows, glossary] = await Promise.all([
    prisma.fieldGroup.findMany({ where: { templateId: doc.template.id }, select: groupSelect, take: MAX_GROUPS }),
    prisma.field.findMany({ where: { templateId: doc.template.id, deletedAt: null }, select: fieldSelect, take: MAX_FIELDS }),
    prisma.glossaryEntry.findMany({ where: { bookId: doc.bookId }, select: { id: true, term: true, meaning: true, position: true }, take: 500 }),
  ]);
  const snapshot = buildTemplateSnapshot(doc.template, groups, fieldRows.map(toFieldView));
  const sequenceFieldId = snapshot.fields.find((f) => f.isSequence)?.id ?? null;
  const provider = getProvider();

  let completed = 0;
  let failed = 0;
  let retryLater: RetryLater | null = null;
  const requeue: string[] = [];

  for (const run of claimed) {
    if (retryLater) {
      requeue.push(run.id);
      continue;
    }
    try {
      if (!snapshot.fields.some((f) => f.mode === "EXTRACT")) throw new RunFailure("The template has no fields set to Extract.");
      const model = modelIdSchema.safeParse(run.model);
      if (!model.success) throw new RunFailure("The model chosen for this run is no longer available. Extract again.");
      const images = await loadImages(doc.bookId, documentId, run.photoIds);
      const result = await provider.extract({
        images,
        template: snapshot,
        glossary: sortByPosition(glossary).map((g) => ({ term: g.term, meaning: g.meaning })),
        book: doc.book,
        model: model.data,
      });
      if (await writeRun(documentId, run, images, result, sequenceFieldId)) completed++;
    } catch (err) {
      if (err instanceof RunFailure) {
        await failRun(run.id, err.message);
        failed++;
      } else if (err instanceof ProviderError) {
        if (err.transient && !opts.isLastAttempt) {
          retryLater = new RetryLater(err.kind === "RATE_LIMITED", err);
          requeue.push(run.id);
        } else {
          if (err.kind !== "INVALID_RESPONSE") log.warn("extraction provider error", { documentId, runId: run.id, kind: err.kind, error: err.message });
          await failRun(run.id, providerErrorMessage(err), { usage: err.usage, responses: err.rawResponse?.responses });
          failed++;
        }
      } else if (!opts.isLastAttempt) {
        log.error("extraction attempt failed", err, { documentId, runId: run.id });
        retryLater = new RetryLater(false, err);
        requeue.push(run.id);
      } else {
        log.error("extraction failed", err, { documentId, runId: run.id });
        await failRun(run.id, "Something went wrong while extracting these pages. Retry them.");
        failed++;
      }
    }
    if (!retryLater) await prisma.$transaction((tx) => recomputeDocumentRun(tx, documentId));
  }

  if (retryLater) {
    await prisma.extractionRun.updateMany({ where: { id: { in: requeue }, state: "RUNNING" }, data: { state: "QUEUED", startedAt: null } });
    await prisma.$transaction((tx) => recomputeDocumentRun(tx, documentId));
    throw retryLater;
  }
  return { status: "done", completed, failed };
}
