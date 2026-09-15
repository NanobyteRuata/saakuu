import path from "node:path";

import sharp, { type Sharp } from "sharp";

import { prisma } from "@/lib/db/client";
import { log } from "@/lib/log";
import { enqueuePhotoIngest } from "@/lib/queue";
import { getObjectBuffer, putObject } from "@/lib/storage/s3";
import { baseKey, pdfPageKey, thumbKey, workingKey } from "@/lib/storage/keys";

import { MAX_PDF_PAGES } from "./schemas";
import { cropPixels, isIdentity, normalizeTransform, totalAngle, transformHash, WORKING_MAX_EDGE, type PhotoTransform } from "./transform";

/**
 * Worker-side photo processing. Originals are only ever read here; every write goes to a derived key.
 */
const THUMB_MAX_EDGE = 320;
/** Refuse decoding anything larger (≈120 MP); protects the worker from decompression bombs. */
const MAX_INPUT_PIXELS = 120_000_000;
/**
 * Pixels kept in memory while transforming. Output copies are ≤2048px, so rotating and cropping at
 * 4096px keeps crop quality while capping a raw RGB buffer at ≈50 MB (a 50 MP photo would be 150 MB).
 */
const DECODE_MAX_EDGE = 4096;
const PDF_MAX_EDGE = 3000;
const WHITE = { r: 255, g: 255, b: 255, alpha: 1 };

type Kind = "jpeg" | "png" | "webp" | "heic" | "pdf";

/** Detects the real file type from its first bytes; the declared MIME type is never trusted. */
export function sniffKind(buf: Buffer): Kind | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return "webp";
  if (buf.toString("latin1", 0, 5) === "%PDF-") return "pdf";
  if (buf.toString("latin1", 4, 8) === "ftyp") {
    const brand = buf.toString("latin1", 8, 12);
    if (["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"].includes(brand)) return "heic";
  }
  return null;
}

type Raw = { data: Buffer; width: number; height: number; channels: 1 | 2 | 3 | 4 };

/** A problem with the file itself. Its message is shown to the user and retrying can't fix it. */
class UserFacingError extends Error {}

export function isUserFacingError(err: unknown): err is Error {
  return err instanceof UserFacingError;
}

/**
 * Decodes to upright RGB pixels (HEIC via heic-convert, EXIF orientation applied, alpha flattened to
 * white), downscaled to at most DECODE_MAX_EDGE. Also returns the original's upright dimensions.
 */
async function decodeOriented(buf: Buffer, kind: Exclude<Kind, "pdf">): Promise<{ raw: Raw; width: number; height: number }> {
  let input = buf;
  if (kind === "heic") {
    const { default: convert } = await import("heic-convert");
    input = Buffer.from(await convert({ buffer: new Uint8Array(buf), format: "JPEG", quality: 0.95 }));
  }
  let meta;
  try {
    meta = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
  } catch {
    throw new UserFacingError("This photo couldn't be read. It may be damaged, or larger than 120 megapixels.");
  }
  const swap = (meta.orientation ?? 1) >= 5;
  const width = (swap ? meta.height : meta.width) ?? 0;
  const height = (swap ? meta.width : meta.height) ?? 0;
  const { data, info } = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS })
    .rotate()
    .resize({ width: DECODE_MAX_EDGE, height: DECODE_MAX_EDGE, fit: "inside", withoutEnlargement: true })
    .flatten({ background: WHITE })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { raw: { data, width: info.width, height: info.height, channels: info.channels }, width, height };
}

function fromRaw(raw: Raw): Sharp {
  return sharp(raw.data, { raw: { width: raw.width, height: raw.height, channels: raw.channels } });
}

async function jpeg(pipeline: Sharp, maxEdge: number, quality: number): Promise<Buffer> {
  return pipeline
    .resize({ width: maxEdge, height: maxEdge, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality, mozjpeg: false })
    .toBuffer();
}

/** Applies a transform to upright pixels: rotate (expanding, white fill), then crop in the rotated frame. */
export async function applyTransform(raw: Raw, t: PhotoTransform): Promise<Raw> {
  let current = raw;
  const angle = totalAngle(t);
  if (angle % 360 !== 0) {
    const { data, info } = await fromRaw(current)
      .rotate(angle, { background: WHITE })
      .raw()
      .toBuffer({ resolveWithObject: true });
    current = { data, width: info.width, height: info.height, channels: info.channels };
  }
  if (t.crop) {
    const rect = cropPixels(current, t.crop);
    const { data, info } = await fromRaw(current).extract(rect).raw().toBuffer({ resolveWithObject: true });
    current = { data, width: info.width, height: info.height, channels: info.channels };
  }
  return current;
}

async function renderCopies(raw: Raw, t: PhotoTransform): Promise<{ working: Buffer; thumb: Buffer }> {
  const transformed = isIdentity(t) ? raw : await applyTransform(raw, t);
  const working = await jpeg(fromRaw(transformed), WORKING_MAX_EDGE, 85);
  const thumb = await jpeg(sharp(working), THUMB_MAX_EDGE, 78);
  return { working, thumb };
}

async function loadOriginal(originalKey: string): Promise<{ buf: Buffer; kind: Kind }> {
  const buf = await getObjectBuffer(originalKey);
  const kind = sniffKind(buf);
  if (!kind) throw new UserFacingError("This file isn't a photo or PDF we can read.");
  return { buf, kind };
}

/**
 * Renders each PDF page to PNG (long edge ≤ 3000px, ≈250 dpi on A4) and stores it as soon as it's
 * drawn, so only one page is in memory at a time. pdfjs-dist is pinned to 5.4.x: 6.x needs Node 22
 * APIs and the image runs Node 20.
 */
async function renderPdfPages(buf: Buffer, pdfKey: string): Promise<{ key: string; byteSize: number }[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // Resolved from the project root: works in the worker (tsx, CJS) and in Next alike.
  const pdfjsRoot = path.join(process.cwd(), "node_modules", "pdfjs-dist");
  const task = pdfjs.getDocument({
    data: new Uint8Array(buf),
    disableFontFace: true,
    useSystemFonts: false,
    standardFontDataUrl: `${path.join(pdfjsRoot, "standard_fonts")}${path.sep}`,
  });
  let doc;
  try {
    doc = await task.promise;
  } catch {
    await task.destroy();
    throw new UserFacingError("This PDF couldn't be opened. It may be damaged or password-protected.");
  }
  try {
    if (doc.numPages > MAX_PDF_PAGES) {
      throw new UserFacingError(`This PDF has ${doc.numPages} pages. Upload at most ${MAX_PDF_PAGES} pages per PDF.`);
    }
    // Use pdfjs's own canvas factory: it draws with Path2D from its bundled @napi-rs/canvas, and a
    // canvas from any other copy of that package rejects those paths.
    const factory = doc.canvasFactory as {
      create(width: number, height: number): {
        canvas: { width: number; height: number; toBuffer(mime: "image/png"): Buffer };
        context: CanvasRenderingContext2D;
      };
      destroy(pair: unknown): void;
    };
    const stored: { key: string; byteSize: number }[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(250 / 72, PDF_MAX_EDGE / Math.max(base.width, base.height));
      const viewport = page.getViewport({ scale });
      const pair = factory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
      pair.context.fillStyle = "#ffffff";
      pair.context.fillRect(0, 0, pair.canvas.width, pair.canvas.height);
      await page.render({ canvas: null, canvasContext: pair.context, viewport }).promise;
      const png = pair.canvas.toBuffer("image/png");
      factory.destroy(pair);
      page.cleanup();
      const key = pdfPageKey(pdfKey, n);
      await putObject(key, png, "image/png");
      stored.push({ key, byteSize: png.length });
    }
    return stored;
  } finally {
    await task.destroy();
  }
}

/** Photo with its document and book, or null when either was deleted: nothing to process then. */
async function loadLivePhoto(photoId: string) {
  const photo = await prisma.photo.findUnique({
    where: { id: photoId },
    select: {
      id: true,
      originalKey: true,
      status: true,
      transform: true,
      documentId: true,
      document: { select: { bookId: true, deletedAt: true, book: { select: { deletedAt: true } } } },
    },
  });
  if (!photo || photo.document.deletedAt !== null || photo.document.book.deletedAt !== null) return null;
  return photo;
}

/**
 * Ingests an uploaded photo: writes base, working and thumbnail copies and records the upright
 * dimensions. A PDF placeholder is replaced by one photo per page, in place, and each page is
 * ingested by its own job. Safe to re-run. Photos of a deleted document or book are skipped:
 * rendering and storing copies nobody can see only costs worker time and storage.
 */
export async function ingestPhoto(photoId: string): Promise<{ status: string; pages?: number }> {
  const photo = await loadLivePhoto(photoId);
  if (!photo) return { status: "gone" };
  if (photo.status === "DONE") return { status: "already-done" };
  await prisma.photo.update({ where: { id: photoId }, data: { status: "PROCESSING", errorMessage: null } });

  const { buf, kind } = await loadOriginal(photo.originalKey);
  const bookId = photo.document.bookId;

  if (kind === "pdf") {
    const pages = await renderPdfPages(buf, photo.originalKey);
    const created = await prisma.$transaction(async (tx) => {
      // Same lock as every document structure change, and it only succeeds while the book is live.
      const liveBook = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "Book" WHERE id = ${bookId} AND "deletedAt" IS NULL FOR UPDATE`;
      if (liveBook.length === 0) return null;
      const current = await tx.photo.findFirst({
        where: { id: photoId, document: { deletedAt: null } },
        select: { documentId: true, pageIndex: true },
      });
      if (!current) return null;
      const later = await tx.photo.findMany({
        where: { documentId: current.documentId, pageIndex: { gt: current.pageIndex } },
        orderBy: { pageIndex: "desc" },
        select: { id: true, pageIndex: true },
      });
      for (const p of later) {
        await tx.photo.update({ where: { id: p.id }, data: { pageIndex: p.pageIndex + pages.length - 1 } });
      }
      await tx.photo.delete({ where: { id: photoId } });
      const ids: string[] = [];
      for (const [i, page] of pages.entries()) {
        const row = await tx.photo.create({
          data: {
            documentId: current.documentId,
            pageIndex: current.pageIndex + i,
            originalKey: page.key,
            mimeType: "image/png",
            width: 0,
            height: 0,
            byteSize: page.byteSize,
            status: "QUEUED",
          },
          select: { id: true },
        });
        ids.push(row.id);
      }
      return ids;
    });
    // Deleted while rendering: the page files stay for storage cleanup (Phase 9), no rows are written.
    if (created === null) return { status: "gone" };
    for (const id of created) await enqueuePhotoIngest({ photoId: id });
    return { status: "split", pages: created.length };
  }

  const { raw, width, height } = await decodeOriented(buf, kind);
  const t = normalizeTransform(photo.transform);
  const hash = transformHash(t);
  const base = await jpeg(fromRaw(raw), WORKING_MAX_EDGE, 88);
  const { working, thumb } = await renderCopies(raw, t);
  await putObject(baseKey(bookId, photoId), base, "image/jpeg");
  await putObject(workingKey(bookId, photoId, hash), working, "image/jpeg");
  await putObject(thumbKey(bookId, photoId, hash), thumb, "image/jpeg");
  await prisma.photo.update({
    where: { id: photoId },
    data: {
      width,
      height,
      workingKey: workingKey(bookId, photoId, hash),
      thumbKey: thumbKey(bookId, photoId, hash),
      status: "DONE",
      errorMessage: null,
    },
  });
  return { status: "done" };
}

/**
 * Re-renders working copy and thumbnail for the photo's current transform. The result is stored
 * only if the transform is unchanged when rendering finishes, so a slow render for an older
 * transform can never replace the copy for a newer one.
 */
export async function renderPhoto(photoId: string): Promise<{ status: string }> {
  const photo = await loadLivePhoto(photoId);
  if (!photo) return { status: "gone" };
  if (photo.status !== "DONE") return { status: "not-ingested" };
  const t = normalizeTransform(photo.transform);
  const hash = transformHash(t);
  const bookId = photo.document.bookId;
  const { buf, kind } = await loadOriginal(photo.originalKey);
  if (kind === "pdf") return { status: "pdf-placeholder" };
  const { raw } = await decodeOriented(buf, kind);
  const { working, thumb } = await renderCopies(raw, t);
  await putObject(workingKey(bookId, photoId, hash), working, "image/jpeg");
  await putObject(thumbKey(bookId, photoId, hash), thumb, "image/jpeg");
  const stored = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ transform: unknown }[]>`SELECT transform FROM "Photo" WHERE id = ${photoId} FOR UPDATE`;
    const row = rows[0];
    if (!row || transformHash(normalizeTransform(row.transform)) !== hash) return false;
    await tx.photo.update({
      where: { id: photoId },
      data: { workingKey: workingKey(bookId, photoId, hash), thumbKey: thumbKey(bookId, photoId, hash), errorMessage: null },
    });
    return true;
  });
  return { status: stored ? "rendered" : "superseded" };
}

/** Ingest failed for good: the photo can't be used. */
export async function markPhotoFailed(photoId: string, err: unknown): Promise<void> {
  const message = isUserFacingError(err) ? err.message : "We couldn't process this photo. Try uploading it again.";
  if (!isUserFacingError(err)) log.error("photo processing failed", err, { photoId });
  await prisma.photo.updateMany({ where: { id: photoId }, data: { status: "FAILED", errorMessage: message } });
}

/**
 * A render for an edit failed for good. The photo stays DONE (original and upright copy are fine, and
 * it stays editable); the message tells the user the edit wasn't applied, and saving again retries.
 */
export async function markRenderFailed(photoId: string, err: unknown): Promise<void> {
  if (!isUserFacingError(err)) log.error("photo render failed", err, { photoId });
  await prisma.photo.updateMany({
    where: { id: photoId, status: "DONE" },
    data: { errorMessage: "We couldn't apply your edits to this page. Save them again to retry." },
  });
}
