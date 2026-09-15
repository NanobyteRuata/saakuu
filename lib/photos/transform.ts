import { z } from "zod";

/**
 * Non-destructive photo transform (docs/01 §15). Stored as JSON on `Photo.transform`, applied at
 * render time to the EXIF-oriented original. Pure and client-safe: the editor preview and the
 * worker render both use this geometry, so what the user saves is what the model sees.
 *
 * Order: rotate the image by `rotate + deskew` degrees about its centre, expanding the canvas to
 * the rotated bounding box (white fill); then crop, where `crop` is normalised 0..1 to that
 * rotated bounding box.
 */

export const MAX_DESKEW_DEGREES = 15;

/** Long edge of the working copy, the image sent to the model (docs/03 §6). */
export const WORKING_MAX_EDGE = 2048;

const unit = z.number().min(0).max(1);

export const cropSchema = z
  .object({ x: unit, y: unit, w: unit.refine((v) => v > 0.01, "Crop is too small."), h: unit.refine((v) => v > 0.01, "Crop is too small.") })
  .refine((c) => c.x + c.w <= 1.0001 && c.y + c.h <= 1.0001, "Crop goes outside the photo.");

export const photoTransformSchema = z.object({
  crop: cropSchema.nullable().optional(),
  rotate: z.number().min(-360).max(360).default(0),
  deskew: z.number().min(-MAX_DESKEW_DEGREES).max(MAX_DESKEW_DEGREES).default(0),
});

export type Crop = z.infer<typeof cropSchema>;
export type PhotoTransform = { crop: Crop | null; rotate: number; deskew: number };

export const IDENTITY_TRANSFORM: PhotoTransform = { crop: null, rotate: 0, deskew: 0 };

const round = (v: number, places: number) => Math.round(v * 10 ** places) / 10 ** places;

/** Canonical form: rotate in [0, 360), angles to 0.01°, crop to 1e-4; a full-frame crop is no crop. */
export function normalizeTransform(input: unknown): PhotoTransform {
  const parsed = photoTransformSchema.safeParse(input ?? {});
  if (!parsed.success) return IDENTITY_TRANSFORM;
  const { crop, rotate, deskew } = parsed.data;
  const r = round(((rotate % 360) + 360) % 360, 2);
  let c: Crop | null = crop
    ? { x: round(crop.x, 4), y: round(crop.y, 4), w: round(crop.w, 4), h: round(crop.h, 4) }
    : null;
  if (c && c.x <= 0 && c.y <= 0 && c.w >= 1 && c.h >= 1) c = null;
  return { crop: c, rotate: r === 360 ? 0 : r, deskew: round(deskew, 2) };
}

export function isIdentity(t: PhotoTransform): boolean {
  return t.crop === null && t.rotate === 0 && t.deskew === 0;
}

/** Stable string for hashing; identical transforms always produce the same text. */
export function transformKey(t: PhotoTransform): string {
  const c = t.crop ? `${t.crop.x},${t.crop.y},${t.crop.w},${t.crop.h}` : "none";
  return `r${t.rotate}|d${t.deskew}|c${c}`;
}

/** Short, deterministic, non-cryptographic hash (FNV-1a, 2 rounds) usable on client and server. */
export function transformHash(t: PhotoTransform): string {
  const text = transformKey(t);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 0x01000193);
    h2 = Math.imul(h2 ^ ch, 0x5bd1e995);
  }
  return ((h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0")).slice(0, 16);
}

export function totalAngle(t: PhotoTransform): number {
  return t.rotate + t.deskew;
}

/** Size of the bounding box of a `width × height` image rotated by `degrees`. */
export function rotatedSize(width: number, height: number, degrees: number): { width: number; height: number } {
  const rad = (degrees * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  // Snap near-right angles so 90° turns don't gain a pixel of float noise.
  const c = cos < 1e-9 ? 0 : cos;
  const s = sin < 1e-9 ? 0 : sin;
  return { width: Math.round(width * c + height * s), height: Math.round(width * s + height * c) };
}

/** Crop rectangle in pixels of the rotated canvas, clamped to it and at least 1px. */
export function cropPixels(
  canvas: { width: number; height: number },
  crop: Crop | null,
): { left: number; top: number; width: number; height: number } {
  if (!crop) return { left: 0, top: 0, width: canvas.width, height: canvas.height };
  const left = Math.min(canvas.width - 1, Math.max(0, Math.round(crop.x * canvas.width)));
  const top = Math.min(canvas.height - 1, Math.max(0, Math.round(crop.y * canvas.height)));
  const width = Math.max(1, Math.min(canvas.width - left, Math.round(crop.w * canvas.width)));
  const height = Math.max(1, Math.min(canvas.height - top, Math.round(crop.h * canvas.height)));
  return { left, top, width, height };
}

/**
 * Keeps a crop on the same part of the photo when the rotation changes. The crop is normalised to
 * the rotated bounding box, which grows or shrinks with the angle; this keeps its pixel size and its
 * offset from the centre, then clamps it inside the new box. A full-frame crop stays full-frame.
 */
export function rescaleCrop(
  crop: Crop,
  from: { width: number; height: number },
  to: { width: number; height: number },
): Crop {
  if (crop.x <= 0 && crop.y <= 0 && crop.w >= 1 && crop.h >= 1) return crop;
  if (from.width <= 0 || from.height <= 0 || to.width <= 0 || to.height <= 0) return crop;
  const wPx = crop.w * from.width;
  const hPx = crop.h * from.height;
  const cxPx = (crop.x + crop.w / 2) * from.width - from.width / 2;
  const cyPx = (crop.y + crop.h / 2) * from.height - from.height / 2;
  const w = Math.min(1, wPx / to.width);
  const h = Math.min(1, hPx / to.height);
  const x = Math.min(1 - w, Math.max(0, (cxPx + to.width / 2) / to.width - w / 2));
  const y = Math.min(1 - h, Math.max(0, (cyPx + to.height / 2) / to.height - h / 2));
  return { x, y, w, h };
}

/** Output dimensions of a rendered transform for a source of the given (oriented) size. */
export function outputSize(source: { width: number; height: number }, t: PhotoTransform): { width: number; height: number } {
  const canvas = rotatedSize(source.width, source.height, totalAngle(t));
  const rect = cropPixels(canvas, t.crop);
  return { width: rect.width, height: rect.height };
}
