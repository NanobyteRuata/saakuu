import { createHash } from "node:crypto";

import { z } from "zod";

import { CONTENT_STATES, type ExtractedContentState } from "@/lib/ai/provider";
import type { ContentState, RunState } from "@/lib/documents/schemas";
import { stableStringify } from "@/lib/impact";

import { MISMATCH_THRESHOLD } from "./schemas";

/**
 * Pure extraction planning: request chunks, idempotency keys, which run is current for each page,
 * which raw records a new run replaces, and how runs roll up into the document's states.
 */

/** docs/03 §6: max 8 images per request. */
export const MAX_IMAGES_PER_REQUEST = 8;
export const MAX_REQUEST_BYTES = 15 * 1024 * 1024;
/** recordIndex = first page index of the request × this + position in the response. */
export const RECORD_INDEX_PAGE_STRIDE = 1000;

export function chunkPages<T>(pages: T[], size = MAX_IMAGES_PER_REQUEST): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < pages.length; i += size) out.push(pages.slice(i, i + size));
  return out;
}

/**
 * docs/03 §7: hash(documentId, model, promptVersion, photoIds, transformHash, passIndex, nonce). The
 * nonce is made once per user action, so a double submit produces the same key and inserts nothing.
 */
export function extractionKey(input: {
  documentId: string;
  model: string;
  promptVersion: string;
  pages: { photoId: string; transformHash: string }[];
  passIndex: number;
  nonce: string;
}): string {
  return createHash("sha256").update(stableStringify(input)).digest("hex");
}

export type RunLite = { id: string; state: RunState; photoIds: string[]; createdAt: Date };

function newestFirst(a: RunLite, b: RunLite): number {
  return b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}

/** For each page, the newest run that covered it. Returned newest first, each run once. */
export function currentRuns<R extends RunLite>(photoIds: string[], runs: R[]): R[] {
  const sorted = [...runs].sort(newestFirst);
  const out: R[] = [];
  for (const photoId of photoIds) {
    const run = sorted.find((r) => r.photoIds.includes(photoId));
    if (run && !out.includes(run)) out.push(run);
  }
  return out.sort(newestFirst);
}

export type RecordLite = { id: string; runId: string; runCreatedAt: Date; photoId: string | null };

/**
 * Raw records a run's results replace: records of this document from older runs on the same pages
 * (or with no page). Records on other pages stay, so retrying one failed chunk keeps the rest.
 * Records from newer runs are never removed by an older one.
 */
export function supersededRecordIds(records: RecordLite[], run: { id: string; photoIds: string[]; createdAt: Date }): string[] {
  const pages = new Set(run.photoIds);
  return records
    .filter((r) => r.runId !== run.id && r.runCreatedAt.getTime() <= run.createdAt.getTime() && (r.photoId === null || pages.has(r.photoId)))
    .map((r) => r.id);
}

export function rollupRunState(states: RunState[]): RunState {
  if (states.length === 0) return "NEVER_RUN";
  const finished = states.filter((s) => s === "COMPLETE" || s === "FAILED").length;
  if (states.includes("RUNNING") || (states.includes("QUEUED") && finished > 0)) return "RUNNING";
  if (states.includes("QUEUED")) return "QUEUED";
  if (states.every((s) => s === "COMPLETE")) return "COMPLETE";
  if (states.every((s) => s === "FAILED")) return "FAILED";
  return "PARTIAL";
}

/** Stored as `rawResponse.summary` on a completed run. */
export const runSummarySchema = z.object({
  contentState: z.enum(CONTENT_STATES),
  anchorsFound: z.array(z.string()),
  records: z.number().int().min(0),
});
export type RunSummary = z.infer<typeof runSummarySchema>;

export function parseRunSummary(rawResponse: unknown): RunSummary | null {
  const parsed = z.object({ summary: runSummarySchema }).safeParse(rawResponse);
  return parsed.success ? parsed.data.summary : null;
}

/** Content with no records is "no rows found" (for a form: no fields found), never a silent empty result. */
function effectiveContent(s: RunSummary): ExtractedContentState {
  return s.contentState === "HAS_CONTENT" && s.records === 0 ? "NO_ROWS_FOUND" : s.contentState;
}

/** Any page with content wins; a document is EMPTY only when every request saw blank pages. */
export function rollupContent(summaries: RunSummary[]): ContentState {
  if (summaries.length === 0) return "UNKNOWN";
  const states = summaries.map(effectiveContent);
  if (states.includes("HAS_CONTENT")) return "HAS_CONTENT";
  if (states.includes("NO_ROWS_FOUND")) return "NO_ROWS_FOUND";
  return "EMPTY";
}

/**
 * Extraction's own reasons to review a document: content but no rows, or a possible template mismatch.
 * The document's `needsReview` is this or any transform flag.
 */
export function extractionNeedsReview(contentState: ContentState, templateMatchScore: number | null): boolean {
  return contentState === "NO_ROWS_FOUND" || (templateMatchScore !== null && templateMatchScore < MISMATCH_THRESHOLD);
}

/** Share of the template's anchors seen on the page, or null when the template declares none. */
export function anchorScore(anchors: string[], found: string[]): number | null {
  if (anchors.length === 0) return null;
  const seen = new Set(found);
  return anchors.filter((a) => seen.has(a)).length / anchors.length;
}

/** Page tokens as Gemini counts images: 258 for small images, else 258 per 768px tile. */
export function imageTokens(width: number, height: number): number {
  if (width <= 0 || height <= 0) return 258;
  if (width <= 384 && height <= 384) return 258;
  return Math.ceil(width / 768) * Math.ceil(height / 768) * 258;
}
