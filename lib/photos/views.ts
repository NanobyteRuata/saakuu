import type { PhotoStatus, Prisma } from "@prisma/client";

import { baseKey } from "@/lib/storage/keys";
import { presignGet } from "@/lib/storage/s3";

import { normalizeTransform, type PhotoTransform } from "./transform";

export const photoSelect = {
  id: true,
  documentId: true,
  pageIndex: true,
  mimeType: true,
  width: true,
  height: true,
  byteSize: true,
  transform: true,
  status: true,
  errorMessage: true,
  workingKey: true,
  thumbKey: true,
  document: { select: { bookId: true } },
} satisfies Prisma.PhotoSelect;

type PhotoRow = Prisma.PhotoGetPayload<{ select: typeof photoSelect }>;

export type PhotoView = {
  id: string;
  documentId: string;
  pageIndex: number;
  mimeType: string;
  width: number;
  height: number;
  byteSize: number;
  transform: PhotoTransform;
  status: PhotoStatus;
  /** Why processing failed (status FAILED), or why the last edit couldn't be applied (status DONE). */
  errorMessage: string | null;
  /** Transformed thumbnail; null until processed. */
  thumbUrl: string | null;
  /** Transformed working copy; null while a new transform is rendering. */
  workingUrl: string | null;
  /** Upright copy without the transform, for the editor; null until processed. */
  baseUrl: string | null;
};

export async function toPhotoView(p: PhotoRow): Promise<PhotoView> {
  const done = p.status === "DONE";
  const [thumbUrl, workingUrl, baseUrl] = await Promise.all([
    p.thumbKey ? presignGet(p.thumbKey) : null,
    p.workingKey ? presignGet(p.workingKey) : null,
    done ? presignGet(baseKey(p.document.bookId, p.id)) : null,
  ]);
  return {
    id: p.id,
    documentId: p.documentId,
    pageIndex: p.pageIndex,
    mimeType: p.mimeType,
    width: p.width,
    height: p.height,
    byteSize: p.byteSize,
    transform: normalizeTransform(p.transform),
    status: p.status,
    errorMessage: p.errorMessage,
    thumbUrl,
    workingUrl,
    baseUrl,
  };
}
