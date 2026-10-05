/**
 * Object storage key layout.
 *
 *   books/{bookId}/uploads/{uploadId}/original.{ext}   written once by the browser, never by us
 *   books/{bookId}/pages/{uploadId}/page-{n}.png       PDF page rendered once; that page's original
 *   books/{bookId}/photos/{photoId}/base.jpg           EXIF-oriented, ≤2048px, no transform
 *   books/{bookId}/photos/{photoId}/working-{th}.jpg   transform applied, ≤2048px, sent to the model
 *   books/{bookId}/photos/{photoId}/thumb-{th}.jpg     transform applied, grid thumbnail
 *
 * `th` is a prefix of the transform hash, so a render for an old transform never overwrites the
 * copy for the current one.
 *
 * An `uploads/` or `pages/` key is written once: by the browser, by rendering a PDF, or by a
 * server-side copy of another original when a page is copied into or out of a template's specimens
 * (decision 78). Either way it is never overwritten.
 */

export const UPLOAD_EXTENSIONS = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
  "application/pdf": "pdf",
} as const;

export type UploadMimeType = keyof typeof UPLOAD_EXTENSIONS;

export function uploadKey(bookId: string, uploadId: string, mimeType: UploadMimeType): string {
  return `books/${bookId}/uploads/${uploadId}/original.${UPLOAD_EXTENSIONS[mimeType]}`;
}

/** Matches keys issued by `uploadKey` for this book only. */
export function isUploadKeyForBook(key: string, bookId: string): boolean {
  return new RegExp(`^books/${bookId}/uploads/[a-z0-9]{24,32}/original\\.(jpg|png|webp|heic|heif|pdf)$`).test(key);
}

/** Rendered PDF page for the PDF at `pdfKey` (an upload key). 1-based page number. */
export function pdfPageKey(pdfKey: string, pageNumber: number): string {
  const dir = pdfKey.slice(0, pdfKey.lastIndexOf("/")).replace("/uploads/", "/pages/");
  return `${dir}/page-${String(pageNumber).padStart(3, "0")}.png`;
}

/**
 * Where a copy of an original goes (decision 78). An upload keeps its file name under a new upload id;
 * a rendered PDF page keeps its page file name under a new upload id in `pages/`. The source PDF is not
 * copied: the copied page is its own original.
 */
export function copiedOriginalKey(originalKey: string, newUploadId: string): string {
  const m = /^(books\/[^/]+\/(?:uploads|pages))\/[^/]+\/([^/]+)$/.exec(originalKey);
  if (!m) throw new Error(`not an original key: ${originalKey}`);
  return `${m[1]}/${newUploadId}/${m[2]}`;
}

/** A render of one photo as the same file of another: `photos/{from}/…` becomes `photos/{to}/…`. */
export function copiedRenderKey(key: string, fromPhotoId: string, toPhotoId: string): string {
  const marker = `/photos/${fromPhotoId}/`;
  if (!key.includes(marker)) throw new Error(`render key ${key} is not under photo ${fromPhotoId}`);
  return key.replace(marker, `/photos/${toPhotoId}/`);
}

export function baseKey(bookId: string, photoId: string): string {
  return `books/${bookId}/photos/${photoId}/base.jpg`;
}

export function workingKey(bookId: string, photoId: string, transformHash: string): string {
  return `books/${bookId}/photos/${photoId}/working-${transformHash.slice(0, 12)}.jpg`;
}

export function thumbKey(bookId: string, photoId: string, transformHash: string): string {
  return `books/${bookId}/photos/${photoId}/thumb-${transformHash.slice(0, 12)}.jpg`;
}
