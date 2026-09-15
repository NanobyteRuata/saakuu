import { z } from "zod";

import { UPLOAD_EXTENSIONS, type UploadMimeType } from "@/lib/storage/keys";
import { idSchema } from "@/lib/validation";

import { cropSchema, MAX_DESKEW_DEGREES } from "./transform";

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const MAX_PDF_PAGES = 100;

export const UPLOAD_MIME_TYPES = Object.keys(UPLOAD_EXTENSIONS) as UploadMimeType[];

/** Browsers report HEIC inconsistently (often empty); the client resolves it from the extension first. */
export function mimeTypeFromFilename(filename: string): UploadMimeType | null {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  const map: Record<string, UploadMimeType> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    heic: "image/heic",
    heif: "image/heif",
    pdf: "application/pdf",
  };
  return map[ext] ?? null;
}

export const createUploadBatchSchema = z.object({ templateId: idSchema });

export const presignUploadSchema = z.object({
  templateId: idSchema,
  filename: z.string().trim().min(1).max(255),
  mimeType: z.enum(UPLOAD_MIME_TYPES as [UploadMimeType, ...UploadMimeType[]], {
    error: "Only JPEG, PNG, WebP, HEIC and PDF files can be uploaded.",
  }),
  byteSize: z
    .number()
    .int()
    .min(1, "This file is empty.")
    .max(MAX_UPLOAD_BYTES, "Files can be at most 25 MB."),
});
export type PresignUploadInput = z.infer<typeof presignUploadSchema>;

export const completeUploadSchema = z.object({
  key: z.string().min(1).max(500),
  templateId: idSchema,
  batchId: idSchema.optional(),
  filename: z.string().trim().min(1).max(255),
});
export type CompleteUploadInput = z.infer<typeof completeUploadSchema>;

export const updateTransformSchema = z.object({
  crop: cropSchema.nullable().optional(),
  rotate: z.number().min(-360).max(360).optional(),
  deskew: z.number().min(-MAX_DESKEW_DEGREES).max(MAX_DESKEW_DEGREES).optional(),
});
export type UpdateTransformInput = z.infer<typeof updateTransformSchema>;

/** `rotate` is the editor's current (possibly unsaved) turn; the suggestion is for that orientation. */
export const autodeskewSchema = z.object({ rotate: z.number().min(-360).max(360).default(0) });

export const photoStatusQuerySchema = z.object({
  ids: z
    .string()
    .transform((s) => s.split(",").filter(Boolean))
    .pipe(z.array(idSchema).min(1).max(200)),
});

export const deletePhotoSchema = z.object({
  impactHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  confirm: z.literal(true, { error: "Confirmation is required for this action." }),
});
export type DeletePhotoInput = z.infer<typeof deletePhotoSchema>;
