import { postJson } from "@/lib/api-client";
import type { Result } from "@/lib/errors";

import { mimeTypeFromFilename, type PresignUploadInput } from "./schemas";

type Presigned = { key: string; url: string; headers: Record<string, string> };

/**
 * Browsers report HEIC inconsistently (often as an empty string), so resolve the type from the
 * filename first and fall back to what the browser claims.
 */
export function uploadMimeType(file: File): string {
  return mimeTypeFromFilename(file.name) ?? file.type;
}

/**
 * PUTs the file straight to storage, reporting progress. XHR rather than fetch because a 25 MB photo
 * over a phone connection needs a progress bar, and fetch cannot report upload progress.
 *
 * `track` registers the request so it can be aborted, and returns the function that unregisters it.
 */
export function putWithProgress(
  url: string,
  file: File,
  contentType: string,
  onProgress: (fraction: number) => void,
  track: (xhr: XMLHttpRequest) => () => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const untrack = track(xhr);
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", contentType);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      untrack();
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`storage responded ${xhr.status}`));
    };
    xhr.onerror = () => {
      untrack();
      reject(new Error("network"));
    };
    xhr.onabort = () => {
      untrack();
      reject(new Error("aborted"));
    };
    xhr.send(file);
  });
}

/**
 * Presign, then PUT to storage. What the caller does with the key afterwards is what makes the upload
 * a new document, a replaced page or an added page (Phase 11).
 */
export async function uploadToStorage(
  templateId: string,
  file: File,
  onProgress: (fraction: number) => void,
  track: (xhr: XMLHttpRequest) => () => void = () => () => undefined,
): Promise<Result<{ key: string }>> {
  const mimeType = uploadMimeType(file);
  const body: PresignUploadInput = { templateId, filename: file.name, mimeType: mimeType as PresignUploadInput["mimeType"], byteSize: file.size };
  const presigned = await postJson<Presigned>("/api/uploads/presign", body);
  if (!presigned.ok) return presigned;
  await putWithProgress(presigned.data.url, file, mimeType, onProgress, track);
  return { ok: true, data: { key: presigned.data.key } };
}
