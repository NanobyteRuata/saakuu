import { createId } from "@paralleldrive/cuid2";
import { Prisma } from "@prisma/client";
import { generateKeyBetween } from "fractional-indexing";
import sharp from "sharp";

import { requireUserId } from "@/lib/auth/guards";
import { assertNoExtractionOutput, lockBook, requireDocumentAccess, requirePhotoAccess, type Db } from "@/lib/documents/access";
import { prisma } from "@/lib/db/client";
import { AppError } from "@/lib/errors";
import { impactHash } from "@/lib/impact";
import { ACTIVE_RUN_STATES, MAX_DOCUMENT_PAGES } from "@/lib/documents/schemas";
import { enqueuePhotoIngest, enqueuePhotoRender } from "@/lib/queue";
import { baseKey, isUploadKeyForBook, pdfPageKey, uploadKey, UPLOAD_EXTENSIONS, type UploadMimeType } from "@/lib/storage/keys";
import { graceMs, scheduleDeletion } from "@/lib/storage/lifecycle";
import { getObjectBuffer, headObject, presignPut } from "@/lib/storage/s3";
import { requireTemplateAccess } from "@/lib/templates/access";

import { estimateSkew } from "./deskew";
import {
  MAX_UPLOAD_BYTES,
  type AddPageInput,
  type CompleteUploadInput,
  type DeletePhotoInput,
  type PresignUploadInput,
  type ReplacePhotoInput,
  type UpdateTransformInput,
} from "./schemas";
import { IDENTITY_TRANSFORM, isIdentity, normalizeTransform, transformHash, type PhotoTransform } from "./transform";
import { photoSelect, toPhotoView, type PhotoView } from "./views";

/** Appended document position within a book. Call under the book lock. */
export async function nextDocumentPosition(tx: Db, bookId: string): Promise<string> {
  const rows = await tx.$queryRaw<{ position: string }[]>`
    SELECT position FROM "Document" WHERE "bookId" = ${bookId}
    ORDER BY position COLLATE "C" DESC LIMIT 1`;
  return generateKeyBetween(rows[0]?.position ?? null, null);
}

export async function createUploadBatch(userId: string, templateId: string): Promise<{ batchId: string }> {
  const { bookId } = await requireTemplateAccess(userId, templateId);
  const batch = await prisma.batch.create({ data: { bookId }, select: { id: true } });
  return { batchId: batch.id };
}

export async function presignUpload(
  userId: string,
  input: PresignUploadInput,
): Promise<{ key: string; url: string; headers: Record<string, string> }> {
  const { bookId } = await requireTemplateAccess(userId, input.templateId);
  const key = uploadKey(bookId, createId(), input.mimeType);
  const url = await presignPut(key, input.mimeType, input.byteSize);
  return { key, url, headers: { "Content-Type": input.mimeType } };
}

function mimeFromKey(key: string): UploadMimeType {
  const ext = key.split(".").pop();
  const entry = Object.entries(UPLOAD_EXTENSIONS).find(([, e]) => e === ext);
  if (!entry) throw new AppError("VALIDATION", "Only JPEG, PNG, WebP, HEIC and PDF files can be uploaded.");
  return entry[0] as UploadMimeType;
}

/** The document's reading is now out of date. Denormalised so the virtualised list can filter on it. */
async function markContentChanged(tx: Db, documentId: string, at: Date): Promise<void> {
  await tx.document.update({ where: { id: documentId }, data: { contentChangedAt: at } });
}

/**
 * A photo of this book already registered for this upload key, or null. Makes completing twice a no-op.
 *
 * Deliberately not filtered to live photos: the question is whether this upload was ever consumed, and a
 * page that has since been replaced consumed it. Callers check *what* it was consumed for before
 * treating it as their own retry (`sameTargetOrRefuse`).
 */
function photoForKey(db: Db, key: string, bookId: string) {
  return db.photo.findFirst({ where: { originalKey: { in: [key, pdfPageKey(key, 1)] }, document: { bookId } }, select: photoSelect });
}

/**
 * An upload key is consumed once. Returning it is right when it is *this* caller's retry, and wrong
 * when it belongs to another page or document — that would report success having changed nothing.
 */
function assertSameTarget(consumed: boolean): void {
  if (!consumed) {
    throw new AppError("CONFLICT", "That upload was already used for another page. Upload the file again.");
  }
}

/** Refuses to change a document's pages while a run is on its way or under way. */
async function assertNotExtracting(db: Db, documentId: string, action: string): Promise<void> {
  const doc = await db.document.findUnique({ where: { id: documentId }, select: { runState: true } });
  if (doc && ACTIVE_RUN_STATES.includes(doc.runState)) {
    throw new AppError(
      "CONFLICT",
      `This document is being extracted right now, so its pages can't change. Wait for the run to finish, then ${action}.`,
    );
  }
}

/** Checks an upload belongs to this book and actually arrived, and returns its size. */
async function checkUpload(key: string, bookId: string): Promise<{ byteSize: number }> {
  if (!isUploadKeyForBook(key, bookId)) {
    throw new AppError("VALIDATION", "This upload doesn't belong to this book. Upload the file again.");
  }
  const head = await headObject(key);
  if (!head) throw new AppError("VALIDATION", "The upload didn't finish. Upload the file again.");
  if (head.byteSize > MAX_UPLOAD_BYTES) throw new AppError("VALIDATION", "Files can be at most 25 MB.");
  if (head.byteSize === 0) throw new AppError("VALIDATION", "This file is empty.");
  return { byteSize: head.byteSize };
}

/**
 * Registers an uploaded file: one new document (one document per photo is the default) holding
 * one photo queued for processing. Completing the same key twice returns the same document.
 */
export async function completeUpload(userId: string, input: CompleteUploadInput): Promise<{ documentId: string; photo: PhotoView }> {
  const { bookId, id: templateId } = await requireTemplateAccess(userId, input.templateId);
  const existing = await photoForKey(prisma, input.key, bookId);
  if (existing) return { documentId: existing.documentId, photo: await toPhotoView(existing) };

  const head = await checkUpload(input.key, bookId);

  if (input.batchId) {
    const batch = await prisma.batch.findFirst({ where: { id: input.batchId, bookId }, select: { id: true } });
    if (!batch) throw new AppError("NOT_FOUND", "That upload session has expired. Start the upload again.");
  }

  const { photo, created } = await prisma.$transaction(async (tx) => {
    await lockBook(tx, bookId);
    // Re-check under the book lock: a double-click or network retry can complete the same key twice.
    const raced = await photoForKey(tx, input.key, bookId);
    if (raced) return { photo: raced, created: false };
    const document = await tx.document.create({
      data: {
        bookId,
        templateId,
        batchId: input.batchId ?? null,
        isSpecimen: input.isSpecimen ?? false,
        label: input.filename,
        position: await nextDocumentPosition(tx, bookId),
        photos: {
          create: {
            pageIndex: 0,
            originalKey: input.key,
            mimeType: mimeFromKey(input.key),
            width: 0,
            height: 0,
            byteSize: head.byteSize,
            status: "QUEUED",
          },
        },
      },
      select: { photos: { select: photoSelect } },
    });
    const first = document.photos[0];
    if (!first) throw new Error("photo was not created");
    return { photo: first, created: true };
  });
  if (created) await enqueuePhotoIngest({ photoId: photo.id });
  return { documentId: photo.documentId, photo: await toPhotoView(photo) };
}

/**
 * Re-shoots one page of an existing document (Phase 11). The new photo takes the old one's place —
 * same document, same page number — and the old one is soft-deleted rather than removed, so a row's
 * provenance chip still opens an image between the replace and the re-extraction.
 *
 * Rows, cells, human edits and reviewed marks are deliberately untouched: they hang off Document and
 * Row, never off Photo, which is what makes this safe and makes deleting the document the wrong
 * workaround (decision 59). `assertNoExtractionOutput` is therefore not consulted here.
 */
export async function replacePhoto(userId: string, photoId: string, input: ReplacePhotoInput): Promise<{ photo: PhotoView }> {
  const { bookId, documentId } = await requirePhotoAccess(userId, photoId);
  const existing = await photoForKey(prisma, input.key, bookId);
  if (existing) {
    assertSameTarget(existing.replacesPhotoId === photoId);
    return { photo: await toPhotoView(existing) };
  }

  const mimeType = mimeFromKey(input.key);
  // A PDF would split into one page per PDF page, which is an import, not a replacement.
  if (mimeType === "application/pdf") {
    throw new AppError("VALIDATION", "Replace a page with a single photo. To bring in a PDF, upload it as a new document.");
  }
  const head = await checkUpload(input.key, bookId);

  const { photo, created } = await prisma.$transaction(async (tx) => {
    await lockBook(tx, bookId);
    const raced = await photoForKey(tx, input.key, bookId);
    if (raced) {
      assertSameTarget(raced.replacesPhotoId === photoId);
      return { photo: raced, created: false };
    }
    // A run in flight still holds this page's id and has no way to notice it was swapped, so it would
    // finish reading the old photo and stamp `lastExtractedAt` after `contentChangedAt` — leaving the
    // document looking freshly read when it is not.
    await assertNotExtracting(tx, documentId, "replace the page");
    const old = await tx.photo.findFirst({ where: { id: photoId, deletedAt: null }, select: { id: true, pageIndex: true } });
    if (!old) throw new AppError("CONFLICT", "That page was already replaced or deleted. Reload the document and try again.");

    const now = new Date();
    const created = await tx.photo.create({
      data: {
        documentId,
        pageIndex: old.pageIndex,
        originalKey: input.key,
        mimeType,
        width: 0,
        height: 0,
        byteSize: head.byteSize,
        status: "QUEUED",
        replacesPhotoId: old.id,
      },
      select: photoSelect,
    });
    await tx.photo.update({ where: { id: old.id }, data: { replacedAt: now, deletedAt: now } });
    await markContentChanged(tx, documentId, now);
    return { photo: created, created: true };
  });
  if (created) await enqueuePhotoIngest({ photoId: photo.id });
  return { photo: await toPhotoView(photo) };
}

/**
 * Adds a page to the end of an existing document (Phase 11), for a multi-page form that was
 * photographed incompletely. Marks the document changed for the same reason a replace does.
 */
export async function addPage(userId: string, documentId: string, input: AddPageInput): Promise<{ photo: PhotoView }> {
  const { bookId } = await requireDocumentAccess(userId, documentId);
  const existing = await photoForKey(prisma, input.key, bookId);
  if (existing) {
    assertSameTarget(existing.documentId === documentId);
    return { photo: await toPhotoView(existing) };
  }

  const mimeType = mimeFromKey(input.key);
  const head = await checkUpload(input.key, bookId);

  const { photo, created } = await prisma.$transaction(async (tx) => {
    await lockBook(tx, bookId);
    const raced = await photoForKey(tx, input.key, bookId);
    if (raced) {
      assertSameTarget(raced.documentId === documentId);
      return { photo: raced, created: false };
    }
    // Same reason as replace: the run would finish and mark the document read without ever seeing this page.
    await assertNotExtracting(tx, documentId, "add the page");
    const last = await tx.photo.findFirst({
      where: { documentId, deletedAt: null },
      orderBy: [{ pageIndex: "desc" }, { id: "desc" }],
      select: { pageIndex: true },
    });
    const pages = await tx.photo.count({ where: { documentId, deletedAt: null } });
    if (pages >= MAX_DOCUMENT_PAGES) {
      throw new AppError("VALIDATION", `A document can hold at most ${MAX_DOCUMENT_PAGES} pages.`);
    }

    const now = new Date();
    const created = await tx.photo.create({
      data: {
        documentId,
        pageIndex: last === null ? 0 : last.pageIndex + 1,
        originalKey: input.key,
        mimeType,
        width: 0,
        height: 0,
        byteSize: head.byteSize,
        status: "QUEUED",
      },
      select: photoSelect,
    });
    await markContentChanged(tx, documentId, now);
    return { photo: created, created: true };
  });
  if (created) await enqueuePhotoIngest({ photoId: photo.id });
  return { photo: await toPhotoView(photo) };
}

const STUCK_QUEUED_MS = 60_000;

/**
 * Current state of photos the user owns, for upload polling. Unknown ids are left out.
 *
 * Replaced pages are deliberately still served (Phase 11): this is also what resolves a row's
 * provenance chip, and between a replace and the re-extraction the row was still read off the old
 * page. They are never re-enqueued for processing, though — they are not pages of the document any more.
 */
export async function getPhotoStatuses(userId: string, ids: string[]): Promise<PhotoView[]> {
  const uid = requireUserId(userId);
  const photos = await prisma.photo.findMany({
    where: { id: { in: ids }, document: { deletedAt: null, book: { userId: uid, deletedAt: null } } },
    select: photoSelect,
    take: ids.length,
  });
  const live = photos.filter((p) => p.deletedAt === null);
  // A photo still QUEUED after a minute lost its job (e.g. Redis was down at enqueue). Re-enqueueing
  // is safe: the job id is the photo id, and ingest skips finished photos.
  const stuck = live.filter((p) => p.status === "QUEUED" && Date.now() - p.createdAt.getTime() > STUCK_QUEUED_MS);
  // Likewise an edited photo whose render was never queued: the job id includes the transform hash,
  // so a render already waiting or running is not duplicated.
  const unrendered = live.filter((p) => p.status === "DONE" && p.workingKey === null && p.errorMessage === null);
  await Promise.all([
    ...stuck.map((p) => enqueuePhotoIngest({ photoId: p.id }).catch(() => undefined)),
    ...unrendered.map((p) =>
      enqueuePhotoRender({ photoId: p.id }, transformHash(normalizeTransform(p.transform))).catch(() => undefined),
    ),
  ]);
  return Promise.all(photos.map(toPhotoView));
}

async function writeTransform(userId: string, photoId: string, build: (current: PhotoTransform) => PhotoTransform): Promise<PhotoView> {
  const { documentId } = await requirePhotoAccess(userId, photoId);
  const { view, hash, needsRender } = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ transform: unknown; status: string; workingKey: string | null }[]>`
      SELECT transform, status, "workingKey" FROM "Photo" WHERE id = ${photoId} FOR UPDATE`;
    const row = rows[0];
    if (!row) throw new AppError("NOT_FOUND", "That photo doesn't exist or was deleted.");
    if (row.status !== "DONE") {
      throw new AppError("CONFLICT", "This photo is still being processed. Try editing it again in a moment.");
    }
    const current = normalizeTransform(row.transform);
    const next = normalizeTransform(build(current));
    const nextHash = transformHash(next);
    const isChanged = nextHash !== transformHash(current);
    const now = new Date();
    // Saving again (even unchanged) after a failed render retries it, so clear the error either way.
    const updated = await tx.photo.update({
      where: { id: photoId },
      data: isChanged
        ? { transform: isIdentity(next) ? Prisma.DbNull : next, transformedAt: now, workingKey: null, errorMessage: null }
        : { errorMessage: null },
      select: photoSelect,
    });
    // A crop changes what the model reads, so the document's last reading is out of date. Recording it
    // is the point: a warning shown once at save time is forgotten across four hundred documents
    // (decision 58).
    if (isChanged) await markContentChanged(tx, documentId, now);
    return { view: await toPhotoView(updated), hash: nextHash, needsRender: isChanged || row.workingKey === null };
  });
  if (needsRender) await enqueuePhotoRender({ photoId }, hash);
  return view;
}

/** Saves the photo's transform. The original is never touched; working copy and thumbnail re-render. */
export async function updatePhotoTransform(userId: string, photoId: string, input: UpdateTransformInput): Promise<PhotoView> {
  return writeTransform(userId, photoId, (current) => ({
    crop: input.crop === undefined ? current.crop : input.crop,
    rotate: input.rotate ?? current.rotate,
    deskew: input.deskew ?? current.deskew,
  }));
}

export async function resetPhotoTransform(userId: string, photoId: string): Promise<PhotoView> {
  return writeTransform(userId, photoId, () => IDENTITY_TRANSFORM);
}

const DESKEW_ANALYSIS_EDGE = 1000;

/** Suggests a deskew angle for the photo turned by `rotate` degrees (the editor's unsaved turn). */
export async function suggestDeskew(userId: string, photoId: string, rotate: number): Promise<{ deskew: number }> {
  const { bookId } = await requirePhotoAccess(userId, photoId);
  const photo = await prisma.photo.findUniqueOrThrow({ where: { id: photoId }, select: { status: true } });
  if (photo.status !== "DONE") {
    throw new AppError("CONFLICT", "This photo is still being processed. Try again in a moment.");
  }
  const base = await getObjectBuffer(baseKey(bookId, photoId));
  const rotated = rotate % 360 === 0 ? base : await sharp(base).rotate(rotate, { background: "#ffffff" }).toBuffer();
  const { data, info } = await sharp(rotated)
    .resize({ width: DESKEW_ANALYSIS_EDGE, height: DESKEW_ANALYSIS_EDGE, fit: "inside", withoutEnlargement: true })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { deskew: estimateSkew(new Uint8Array(data.buffer, data.byteOffset, data.length), info.width, info.height) };
}

export type PhotoDeleteImpact = {
  impactHash: string;
  documentLabel: string | null;
  pages: number;
  deletesDocument: boolean;
};

async function computePhotoDeleteImpact(db: Db, photoId: string): Promise<PhotoDeleteImpact> {
  const photo = await db.photo.findUniqueOrThrow({
    where: { id: photoId },
    select: { documentId: true, document: { select: { label: true, _count: { select: { photos: true } } } } },
  });
  const pages = photo.document._count.photos;
  const counts = { documentLabel: photo.document.label, pages, deletesDocument: pages === 1 };
  return { impactHash: impactHash({ action: "photos.delete", photoId, documentId: photo.documentId, ...counts }), ...counts };
}

export async function photoDeleteImpact(userId: string, photoId: string): Promise<PhotoDeleteImpact> {
  await requirePhotoAccess(userId, photoId);
  return computePhotoDeleteImpact(prisma, photoId);
}

/**
 * Removes a photo from its document and renumbers the remaining pages. Deleting the only page
 * deletes the document. The stored files are tombstoned and removed after the grace period (lib/storage/lifecycle).
 */
export async function deletePhoto(userId: string, photoId: string, input: DeletePhotoInput): Promise<{ documentDeleted: boolean }> {
  const { bookId, documentId } = await requirePhotoAccess(userId, photoId);
  return prisma.$transaction(async (tx) => {
    await lockBook(tx, bookId);
    await requirePhotoAccess(userId, photoId, tx);
    const impact = await computePhotoDeleteImpact(tx, photoId);
    if (impact.impactHash !== input.impactHash) {
      throw new AppError("CONFLICT", "This document's pages changed since you reviewed the deletion. Review it again.");
    }
    await assertNoExtractionOutput(tx, [documentId], "delete a page of");
    const removed = await tx.photo.delete({ where: { id: photoId }, select: { id: true, originalKey: true } });
    await scheduleDeletion(tx, [{ ...removed, bookId }], "PHOTO_DELETED", new Date(Date.now() + graceMs()));
    const rest = await tx.photo.findMany({ where: { documentId }, orderBy: { pageIndex: "asc" }, select: { id: true, pageIndex: true } });
    for (const [i, p] of rest.entries()) {
      if (p.pageIndex !== i) await tx.photo.update({ where: { id: p.id }, data: { pageIndex: i } });
    }
    if (rest.length === 0) {
      await tx.document.update({ where: { id: documentId }, data: { deletedAt: new Date() } });
    }
    return { documentDeleted: rest.length === 0 };
  });
}
