import { createId } from "@paralleldrive/cuid2";
import { Prisma } from "@prisma/client";
import { generateKeyBetween } from "fractional-indexing";
import sharp from "sharp";

import { requireUserId } from "@/lib/auth/guards";
import { assertNoExtractionOutput, lockBook, requirePhotoAccess, type Db } from "@/lib/documents/access";
import { prisma } from "@/lib/db/client";
import { AppError } from "@/lib/errors";
import { impactHash } from "@/lib/impact";
import { enqueuePhotoIngest, enqueuePhotoRender } from "@/lib/queue";
import { baseKey, isUploadKeyForBook, pdfPageKey, uploadKey, UPLOAD_EXTENSIONS, type UploadMimeType } from "@/lib/storage/keys";
import { getObjectBuffer, headObject, presignPut } from "@/lib/storage/s3";
import { requireTemplateAccess } from "@/lib/templates/access";

import { estimateSkew } from "./deskew";
import {
  MAX_UPLOAD_BYTES,
  type CompleteUploadInput,
  type DeletePhotoInput,
  type PresignUploadInput,
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

/**
 * Registers an uploaded file: one new document (one document per photo is the default) holding
 * one photo queued for processing. Completing the same key twice returns the same document.
 */
export async function completeUpload(userId: string, input: CompleteUploadInput): Promise<{ documentId: string; photo: PhotoView }> {
  const { bookId, id: templateId } = await requireTemplateAccess(userId, input.templateId);
  if (!isUploadKeyForBook(input.key, bookId)) {
    throw new AppError("VALIDATION", "This upload doesn't belong to this book. Upload the file again.");
  }
  const existing = await prisma.photo.findFirst({
    where: { originalKey: { in: [input.key, pdfPageKey(input.key, 1)] }, document: { bookId } },
    select: photoSelect,
  });
  if (existing) return { documentId: existing.documentId, photo: await toPhotoView(existing) };

  const head = await headObject(input.key);
  if (!head) throw new AppError("VALIDATION", "The upload didn't finish. Upload the file again.");
  if (head.byteSize > MAX_UPLOAD_BYTES) throw new AppError("VALIDATION", "Files can be at most 25 MB.");
  if (head.byteSize === 0) throw new AppError("VALIDATION", "This file is empty.");

  if (input.batchId) {
    const batch = await prisma.batch.findFirst({ where: { id: input.batchId, bookId }, select: { id: true } });
    if (!batch) throw new AppError("NOT_FOUND", "That upload session has expired. Start the upload again.");
  }

  const { photo, created } = await prisma.$transaction(async (tx) => {
    await lockBook(tx, bookId);
    // Re-check under the book lock: a double-click or network retry can complete the same key twice.
    const raced = await tx.photo.findFirst({
      where: { originalKey: { in: [input.key, pdfPageKey(input.key, 1)] }, document: { bookId } },
      select: photoSelect,
    });
    if (raced) return { photo: raced, created: false };
    const document = await tx.document.create({
      data: {
        bookId,
        templateId,
        batchId: input.batchId ?? null,
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

const STUCK_QUEUED_MS = 60_000;

/** Current state of photos the user owns, for upload polling. Unknown ids are left out. */
export async function getPhotoStatuses(userId: string, ids: string[]): Promise<PhotoView[]> {
  const uid = requireUserId(userId);
  const photos = await prisma.photo.findMany({
    where: { id: { in: ids }, document: { deletedAt: null, book: { userId: uid, deletedAt: null } } },
    select: { ...photoSelect, createdAt: true },
    take: ids.length,
  });
  // A photo still QUEUED after a minute lost its job (e.g. Redis was down at enqueue). Re-enqueueing
  // is safe: the job id is the photo id, and ingest skips finished photos.
  const stuck = photos.filter((p) => p.status === "QUEUED" && Date.now() - p.createdAt.getTime() > STUCK_QUEUED_MS);
  // Likewise an edited photo whose render was never queued: the job id includes the transform hash,
  // so a render already waiting or running is not duplicated.
  const unrendered = photos.filter((p) => p.status === "DONE" && p.workingKey === null && p.errorMessage === null);
  await Promise.all([
    ...stuck.map((p) => enqueuePhotoIngest({ photoId: p.id }).catch(() => undefined)),
    ...unrendered.map((p) =>
      enqueuePhotoRender({ photoId: p.id }, transformHash(normalizeTransform(p.transform))).catch(() => undefined),
    ),
  ]);
  return Promise.all(photos.map(toPhotoView));
}

async function writeTransform(userId: string, photoId: string, build: (current: PhotoTransform) => PhotoTransform): Promise<PhotoView> {
  await requirePhotoAccess(userId, photoId);
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
    // Saving again (even unchanged) after a failed render retries it, so clear the error either way.
    const updated = await tx.photo.update({
      where: { id: photoId },
      data: isChanged
        ? { transform: isIdentity(next) ? Prisma.DbNull : next, workingKey: null, errorMessage: null }
        : { errorMessage: null },
      select: photoSelect,
    });
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
 * deletes the document. The stored files stay until storage cleanup (Phase 9 grace period).
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
    await tx.photo.delete({ where: { id: photoId } });
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
