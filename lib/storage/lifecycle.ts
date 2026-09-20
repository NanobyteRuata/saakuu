import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db/client";
import type { Db } from "@/lib/documents/access";
import { getEnv } from "@/lib/env";
import { log } from "@/lib/log";

import { deleteObjects, listObjects } from "./s3";

/**
 * Storage lifecycle (Phase 9). Object storage is never deleted from anywhere else.
 *
 * - A deleted photo gets a `StorageDeletion` tombstone; its files go once the grace period has passed.
 * - Photos of documents and books deleted longer ago than the grace period are purged: tombstoned
 *   (due at once) and their rows removed. Rows, raw values and runs are kept.
 * - A daily sweep removes objects nothing refers to: abandoned uploads, superseded renders, and files of
 *   photos whose rows vanished without a tombstone.
 *
 * The one rule every path follows: an object any Photo row references is never deleted.
 *
 * Phase 12 adds the one step here that touches Postgres rather than object storage: ageing the model
 * responses off old successful runs (decision 63). It lives here because it is the same daily job and
 * the same question — what is being kept for ever that nobody will read.
 */

const DAY_MS = 24 * 3600 * 1000;
/** Objects younger than this are never swept: an upload or render may be in flight. */
export const SWEEP_MIN_AGE_MS = DAY_MS;
const BATCH = 200;
/**
 * How long a *successful* run keeps the model's full response (decision 63). Failed runs keep theirs
 * for ever — a failure is when the response is actually wanted. Check what it costs before changing
 * this; the query is in docs/09 §8.
 */
export const RAW_RESPONSE_KEEP_DAYS = 30;

export function graceMs(): number {
  return getEnv().PHOTO_DELETE_GRACE_DAYS * DAY_MS;
}

type DeletedPhoto = { id: string; originalKey: string; bookId: string };

/** Tombstones photos about to be removed. Call in the transaction that deletes the rows. */
export async function scheduleDeletion(
  tx: Db,
  photos: DeletedPhoto[],
  reason: "PHOTO_DELETED" | "DOCUMENT_PURGED",
  deleteAfter: Date,
): Promise<void> {
  if (photos.length === 0) return;
  await tx.storageDeletion.createMany({
    data: photos.map((p) => ({ photoId: p.id, bookId: p.bookId, originalKey: p.originalKey, reason, deleteAfter })),
    skipDuplicates: true,
  });
}

// ---------- the pure decision ----------

export type ObjectRefs = {
  /** Keys a Photo row holds as original, working or thumbnail copy. */
  referencedKeys: ReadonlySet<string>;
  /** Photo rows that exist. */
  livePhotoIds: ReadonlySet<string>;
  /** Photos with a tombstone: their files wait for the tombstone, not the sweep. */
  tombstonedPhotoIds: ReadonlySet<string>;
  tombstonedKeys: ReadonlySet<string>;
  /** Upload ids (a PDF) that still have a page photo under pages/{uploadId}/. */
  uploadsWithPages: ReadonlySet<string>;
};

export type SweepDecision = "keep" | "delete";

const KEY = /^books\/([^/]+)\/(uploads|pages|photos)\/([^/]+)\/([^/]+)$/;

export function parseKey(key: string): { area: "uploads" | "pages" | "photos"; id: string; file: string } | null {
  const m = KEY.exec(key);
  if (!m) return null;
  const [, , area, id, file] = m;
  if (!id || !file || (area !== "uploads" && area !== "pages" && area !== "photos")) return null;
  return { area, id, file };
}

/** Whether the sweep may delete an object. Anything it doesn't recognise is kept. */
export function classifyObject(key: string, lastModified: Date, now: Date, refs: ObjectRefs): SweepDecision {
  if (refs.referencedKeys.has(key) || refs.tombstonedKeys.has(key)) return "keep";
  if (now.getTime() - lastModified.getTime() < SWEEP_MIN_AGE_MS) return "keep";
  const parsed = parseKey(key);
  if (!parsed) return "keep";
  switch (parsed.area) {
    case "uploads":
      // A PDF stays while any of its pages is a photo: it is the true original of those pages.
      return refs.uploadsWithPages.has(parsed.id) ? "keep" : "delete";
    case "pages":
      return "delete";
    case "photos":
      if (refs.tombstonedPhotoIds.has(parsed.id)) return "keep";
      if (!refs.livePhotoIds.has(parsed.id)) return "delete";
      // A live photo's base copy is re-rendered from on every edit; working/thumb copies for an old
      // transform are superseded (renders always write a fresh key, and the current one is referenced).
      if (parsed.file.startsWith("working-") || parsed.file.startsWith("thumb-")) return "delete";
      return "keep";
  }
}

async function loadRefs(db: Db, keys: string[]): Promise<ObjectRefs> {
  const parsed = keys.map(parseKey);
  const photoIds = [...new Set(parsed.flatMap((p) => (p?.area === "photos" ? [p.id] : [])))];
  const uploadIds = [...new Set(parsed.flatMap((p) => (p?.area === "uploads" ? [p.id] : [])))];
  const [byKey, live, tombstones, pages] = await Promise.all([
    db.photo.findMany({
      where: { OR: [{ originalKey: { in: keys } }, { workingKey: { in: keys } }, { thumbKey: { in: keys } }] },
      select: { originalKey: true, workingKey: true, thumbKey: true },
      take: keys.length * 3,
    }),
    db.photo.findMany({ where: { id: { in: photoIds } }, select: { id: true, workingKey: true, thumbKey: true }, take: photoIds.length }),
    db.storageDeletion.findMany({
      where: { OR: [{ photoId: { in: photoIds } }, { originalKey: { in: keys } }] },
      select: { photoId: true, originalKey: true },
      take: photoIds.length + keys.length,
    }),
    uploadIds.length === 0
      ? Promise.resolve([] as { uploadId: string }[])
      : db.$queryRaw<{ uploadId: string }[]>`
          SELECT DISTINCT split_part("originalKey", '/', 4) AS "uploadId" FROM "Photo"
          WHERE split_part("originalKey", '/', 3) = 'pages' AND split_part("originalKey", '/', 4) = ANY(${uploadIds})`,
  ]);
  const referencedKeys = new Set<string>();
  for (const p of [...byKey, ...live.map((l) => ({ originalKey: null, ...l }))]) {
    for (const k of [p.originalKey, p.workingKey, p.thumbKey]) if (k) referencedKeys.add(k);
  }
  return {
    referencedKeys,
    livePhotoIds: new Set(live.map((p) => p.id)),
    tombstonedPhotoIds: new Set(tombstones.map((t) => t.photoId)),
    tombstonedKeys: new Set(tombstones.map((t) => t.originalKey)),
    uploadsWithPages: new Set(pages.map((p) => p.uploadId)),
  };
}

// ---------- jobs ----------

export type CleanupOptions = { dryRun?: boolean; now?: Date };
export type CleanupResult = {
  purgedPhotos: number;
  dueDeletions: number;
  deletedObjects: number;
  sweptObjects: number;
  scanned: number;
  strippedResponses: number;
};

/**
 * Tombstones and removes photos deleted longer ago than the grace period: those of a deleted document
 * or book, and pages replaced by a re-shot one (Phase 11). A replaced page's row is kept until now so
 * that provenance from existing rows still resolves to an image; past the grace period it ages out
 * through the same tombstone path as any other deletion.
 */
export async function purgeDeletedPhotos({ dryRun = false, now = new Date() }: CleanupOptions = {}): Promise<number> {
  const cutoff = new Date(now.getTime() - graceMs());
  const where: Prisma.PhotoWhereInput = {
    OR: [{ deletedAt: { lt: cutoff } }, { document: { deletedAt: { lt: cutoff } } }, { document: { book: { deletedAt: { lt: cutoff } } } }],
  };
  if (dryRun) return prisma.photo.count({ where });
  let purged = 0;
  for (;;) {
    const photos = await prisma.photo.findMany({
      where,
      select: { id: true, originalKey: true, deletedAt: true, document: { select: { bookId: true } } },
      orderBy: { id: "asc" },
      take: BATCH,
    });
    if (photos.length === 0) return purged;
    // A page deleted or replaced on its own belongs to a document that is still alive, so it is not a purge.
    const tombstone = (p: (typeof photos)[number]) => ({ id: p.id, originalKey: p.originalKey, bookId: p.document.bookId });
    const own = photos.filter((p) => p.deletedAt !== null);
    const withDocument = photos.filter((p) => p.deletedAt === null);
    await prisma.$transaction(async (tx) => {
      await scheduleDeletion(tx, own.map(tombstone), "PHOTO_DELETED", now);
      await scheduleDeletion(tx, withDocument.map(tombstone), "DOCUMENT_PURGED", now);
      await tx.photo.deleteMany({ where: { id: { in: photos.map((p) => p.id) } } });
    });
    purged += photos.length;
  }
}

/** Deletes the files of tombstones whose grace period has passed, then the tombstones. */
export async function runDueDeletions({ dryRun = false, now = new Date() }: CleanupOptions = {}): Promise<{ tombstones: number; objects: number }> {
  let tombstones = 0;
  let objects = 0;
  let cursor: string | undefined;
  for (;;) {
    const due = await prisma.storageDeletion.findMany({
      where: { deleteAfter: { lte: now }, ...(cursor ? { id: { gt: cursor } } : {}) },
      orderBy: { id: "asc" },
      take: BATCH,
    });
    if (due.length === 0) return { tombstones, objects };
    cursor = due.at(-1)?.id;
    for (const t of due) {
      const keys = new Set<string>([t.originalKey]);
      let token: string | undefined;
      do {
        const page = await listObjects(`books/${t.bookId}/photos/${t.photoId}/`, token);
        for (const o of page.objects) keys.add(o.key);
        token = page.nextToken ?? undefined;
      } while (token);
      const refs = await loadRefs(prisma, [...keys]);
      // A photo row that (still, or again) uses a key keeps it: the tombstone never overrides a live reference.
      const photoStillExists = refs.livePhotoIds.has(t.photoId);
      const deletable = [...keys].filter((k) => !refs.referencedKeys.has(k) && !(photoStillExists && parseKey(k)?.area === "photos"));
      if (!dryRun) {
        if (deletable.length > 0) await deleteObjects(deletable);
        await prisma.storageDeletion.delete({ where: { id: t.id } });
      }
      tombstones++;
      objects += deletable.length;
    }
  }
}

/** Lists every object under books/ and deletes those `classifyObject` marks unreferenced. */
export async function sweepOrphans({ dryRun = false, now = new Date() }: CleanupOptions = {}): Promise<{ scanned: number; deleted: number }> {
  let scanned = 0;
  let deleted = 0;
  let token: string | undefined;
  do {
    const page = await listObjects("books/", token);
    token = page.nextToken ?? undefined;
    scanned += page.objects.length;
    const old = page.objects.filter((o) => now.getTime() - o.lastModified.getTime() >= SWEEP_MIN_AGE_MS);
    if (old.length === 0) continue;
    // Read references right before deciding, so a row written since listing still protects its object.
    const refs = await loadRefs(prisma, old.map((o) => o.key));
    const orphans = old.filter((o) => classifyObject(o.key, o.lastModified, now, refs) === "delete").map((o) => o.key);
    if (orphans.length > 0 && !dryRun) await deleteObjects(orphans);
    deleted += orphans.length;
  } while (token);
  return { scanned, deleted };
}

/**
 * Drops the stored model responses from successful runs older than `RAW_RESPONSE_KEEP_DAYS`
 * (decision 63). `rawResponse - 'responses'` removes exactly one key: the run's `summary` stays, and
 * with it everything that reads it — `parseRunSummary`, the document's run state and the run history.
 * Token counts, timings, `photoIds` and every raw value are untouched, so cost history and provenance
 * are unaffected. `state = 'COMPLETE'` is what keeps failed runs' responses for ever.
 *
 * The `jsonb_typeof = 'object'` guard is not decoration: `jsonb_exists` also matches a bare string and
 * an array element, and `- 'responses'` on a scalar raises "cannot delete from scalar", which would
 * fail the whole nightly job on one malformed row.
 */
export async function stripOldRawResponses({ dryRun = false, now = new Date() }: CleanupOptions = {}): Promise<number> {
  const cutoff = new Date(now.getTime() - RAW_RESPONSE_KEEP_DAYS * DAY_MS);
  if (dryRun) {
    const [row] = await prisma.$queryRaw<{ count: number }[]>`
      SELECT count(*)::int AS count FROM "ExtractionRun"
      WHERE state = 'COMPLETE' AND "finishedAt" < ${cutoff}
        AND jsonb_typeof("rawResponse") = 'object' AND jsonb_exists("rawResponse", 'responses')`;
    return row?.count ?? 0;
  }
  let stripped = 0;
  for (;;) {
    const affected = await prisma.$executeRaw`
      UPDATE "ExtractionRun" SET "rawResponse" = "rawResponse" - 'responses'
      WHERE id IN (
        SELECT id FROM "ExtractionRun"
        WHERE state = 'COMPLETE' AND "finishedAt" < ${cutoff}
        AND jsonb_typeof("rawResponse") = 'object' AND jsonb_exists("rawResponse", 'responses')
        ORDER BY id
        LIMIT ${BATCH})`;
    if (affected === 0) return stripped;
    stripped += affected;
  }
}

/** The daily `storage.cleanup` job: purge → due deletions → sweep → age old model responses. */
export async function runStorageCleanup(options: CleanupOptions = {}): Promise<CleanupResult> {
  const purgedPhotos = await purgeDeletedPhotos(options);
  const due = await runDueDeletions(options);
  const sweep = await sweepOrphans(options);
  const strippedResponses = await stripOldRawResponses(options);
  const result = {
    purgedPhotos,
    dueDeletions: due.tombstones,
    deletedObjects: due.objects,
    sweptObjects: sweep.deleted,
    scanned: sweep.scanned,
    strippedResponses,
  };
  log.info(options.dryRun ? "storage cleanup dry run" : "storage cleanup finished", result);
  return result;
}
