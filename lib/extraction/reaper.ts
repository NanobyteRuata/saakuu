import { prisma } from "@/lib/db/client";
import { log } from "@/lib/log";
import { QUEUES, enqueueExtraction, extractionJobId, jobPresence, queueConnection, requeuePhotoIngest, type JobPresence } from "@/lib/queue";

import { recomputeDocumentRun } from "./service";

/**
 * Stale-run reaper (docs/03 §7, Phase 9). A worker killed mid-job leaves its runs `RUNNING`: BullMQ may
 * restart the job, but the restarted job can't claim a run another claim still holds, so it finishes
 * idle and the document would stay `Running` for good. Every minute this puts such runs back in the
 * queue, or fails them once they have been reaped too often (a page that crashes the worker every time).
 */

/** A run younger than this is never touched: its job may not have shown up as active yet. */
export const REAP_AFTER_MS = 2 * 60_000;
/** Times one run is put back before it is failed. */
export const MAX_REAPS = 3;
/** Photos still processing after this long with no job are re-ingested (up to `MAX_REAPS` times). */
export const PHOTO_STUCK_MS = 10 * 60_000;

export const REAPED_FAILURE_MESSAGE = "The worker stopped while reading these pages. Retry them.";

export type StaleRun = { id: string; documentId: string; reaps: number };

export type ReapPlan = { requeue: StaleRun[]; fail: StaleRun[] };

/**
 * Pure decision. A document whose extraction job is running or waiting to run is left alone: that job
 * owns its runs. Otherwise each run goes back to the queue, unless it already has been `MAX_REAPS` times.
 */
export function planReap(runs: StaleRun[], jobs: ReadonlyMap<string, JobPresence>): ReapPlan {
  const plan: ReapPlan = { requeue: [], fail: [] };
  for (const run of runs) {
    const presence = jobs.get(run.documentId) ?? "none";
    if (presence !== "none") continue;
    (run.reaps >= MAX_REAPS ? plan.fail : plan.requeue).push(run);
  }
  return plan;
}

const reapKey = (id: string) => `saakuu:reap:${id}`;
const photoReapKey = (photoId: string) => `saakuu:reap:photo:${photoId}`;
const REAP_COUNT_TTL_SECONDS = 24 * 3600;
const BATCH = 200;

export const PHOTO_REAPED_FAILURE_MESSAGE = "We couldn't process this photo: it stopped the worker more than once. Try uploading a smaller copy.";

export type ReapResult = { requeued: number; failed: number; documents: number; photos: number; photosFailed: number };

type Counter = { mget(keys: string[]): Promise<(string | null)[]>; bump(key: string): Promise<void> };

/** Reap counters on the system queue's own connection: the reaper runs every minute, so no connection of its own. */
async function counter(): Promise<Counter> {
  const client = await queueConnection(QUEUES.system);
  return {
    mget: (keys) => (keys.length === 0 ? Promise.resolve([]) : client.mget(keys)),
    bump: async (key) => {
      await client.multi().incr(key).expire(key, REAP_COUNT_TTL_SECONDS).exec();
    },
  };
}

export async function reapStale(now = new Date()): Promise<ReapResult> {
  const rows = await prisma.extractionRun.findMany({
    where: { state: "RUNNING", startedAt: { lt: new Date(now.getTime() - REAP_AFTER_MS) } },
    select: { id: true, documentId: true, startedAt: true },
    orderBy: { startedAt: "asc" },
    take: BATCH,
  });
  // The claim time is each write's fencing token; a row without one can't be updated safely, so it is skipped.
  const claimedAt = new Map(rows.flatMap((r) => (r.startedAt ? [[r.id, r.startedAt] as const] : [])));
  const runs = rows.filter((r) => claimedAt.has(r.id));
  const counts = await counter();

  const documentIds = [...new Set(runs.map((r) => r.documentId))];
  const presences = new Map(
    await Promise.all(documentIds.map(async (id) => [id, await jobPresence(QUEUES.extraction, extractionJobId(id))] as const)),
  );
  const reaps = await counts.mget(runs.map((r) => reapKey(r.id)));
  const plan = planReap(
    runs.map((r, i) => ({ id: r.id, documentId: r.documentId, reaps: Number(reaps[i] ?? 0) })),
    presences,
  );

  let requeued = 0;
  let failed = 0;
  const touched = new Set<string>();
  for (const run of plan.requeue) {
    const startedAt = claimedAt.get(run.id);
    if (!startedAt) continue;
    // Guarded by the same startedAt: a run claimed again since it was read is left to its new job.
    const { count } = await prisma.extractionRun.updateMany({
      where: { id: run.id, state: "RUNNING", startedAt },
      data: { state: "QUEUED", startedAt: null },
    });
    if (count === 0) continue;
    await counts.bump(reapKey(run.id));
    requeued++;
    touched.add(run.documentId);
  }
  for (const run of plan.fail) {
    const startedAt = claimedAt.get(run.id);
    if (!startedAt) continue;
    const { count } = await prisma.extractionRun.updateMany({
      where: { id: run.id, state: "RUNNING", startedAt },
      data: { state: "FAILED", finishedAt: now, error: REAPED_FAILURE_MESSAGE },
    });
    if (count === 0) continue;
    failed++;
    touched.add(run.documentId);
  }
  const requeuedDocs = new Set(plan.requeue.map((r) => r.documentId));
  for (const documentId of touched) {
    await prisma.$transaction((tx) => recomputeDocumentRun(tx, documentId));
    if (requeuedDocs.has(documentId)) await enqueueExtraction({ documentId });
  }

  // Documents marked running with no active run (e.g. a recompute lost to a crash): recompute only.
  const drifted = await prisma.document.findMany({
    where: {
      runState: { in: ["RUNNING", "QUEUED"] },
      updatedAt: { lt: new Date(now.getTime() - REAP_AFTER_MS) },
      runs: { none: { state: { in: ["RUNNING", "QUEUED"] } } },
    },
    select: { id: true },
    take: BATCH,
  });
  for (const doc of drifted) await prisma.$transaction((tx) => recomputeDocumentRun(tx, doc.id));

  const photos = await reapStuckPhotos(now, counts);
  const result = { requeued, failed, documents: drifted.length, photos: photos.requeued, photosFailed: photos.failed };
  if (requeued + failed + drifted.length + photos.requeued + photos.failed > 0) log.warn("reaped stale work", result);
  return result;
}

/**
 * Photos stuck `PROCESSING` with no ingest job are re-ingested, at most `MAX_REAPS` times. A file that kills the
 * worker (out of memory on a huge PDF) never reaches the processor's own failure handling, so after that it is
 * failed here instead of crash-looping the worker.
 */
async function reapStuckPhotos(now: Date, counts: Counter): Promise<{ requeued: number; failed: number }> {
  const stuck = await prisma.photo.findMany({
    where: {
      status: "PROCESSING",
      createdAt: { lt: new Date(now.getTime() - PHOTO_STUCK_MS) },
      document: { deletedAt: null, book: { deletedAt: null } },
    },
    select: { id: true },
    take: BATCH,
  });
  const orphaned: string[] = [];
  for (const photo of stuck) {
    if ((await jobPresence(QUEUES.media, `ingest-${photo.id}`)) === "none") orphaned.push(photo.id);
  }
  const reaps = await counts.mget(orphaned.map(photoReapKey));
  let requeued = 0;
  let failed = 0;
  for (const [i, photoId] of orphaned.entries()) {
    if (Number(reaps[i] ?? 0) >= MAX_REAPS) {
      await prisma.photo.updateMany({
        where: { id: photoId, status: "PROCESSING" },
        data: { status: "FAILED", errorMessage: PHOTO_REAPED_FAILURE_MESSAGE },
      });
      failed++;
      continue;
    }
    await counts.bump(photoReapKey(photoId));
    await requeuePhotoIngest({ photoId });
    requeued++;
  }
  return { requeued, failed };
}
