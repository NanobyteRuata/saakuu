import { createHash } from "node:crypto";

import { createId } from "@paralleldrive/cuid2";
import { Prisma } from "@prisma/client";

import { AppError } from "@/lib/errors";
import { currentRuns } from "@/lib/extraction/plan";
import { recomputeDocumentRun } from "@/lib/extraction/service";
import { MAX_DOCUMENT_PAGES } from "@/lib/documents/schemas";
import { nextDocumentPosition } from "@/lib/photos/service";
import { baseKey, copiedOriginalKey, copiedRenderKey } from "@/lib/storage/keys";
import { copyObject } from "@/lib/storage/s3";

import type { Db } from "./access";

/**
 * Copying a document's pages, and optionally its reading, into a new document (decision 78).
 *
 * A specimen belongs to its template and a document to the book's work, so moving a page between them
 * is a copy, never a flag flip: the template keeps its reference page, and a Test never re-reads real
 * data. The copy is independent all the way down. Every file is copied server-side rather than shared,
 * because renders live under `photos/{photoId}/` and an upload's idempotency is keyed by its original
 * (`photoForKey`), so two photos on one key would make that check ambiguous.
 *
 * Objects are copied *before* the transaction that writes the rows. If the transaction fails, the new
 * objects belong to no Photo row and the daily sweep removes them (`sweepOrphans`); nothing here
 * deletes storage, which stays the lifecycle's job alone.
 */

/** One source page as it is copied. */
export type SourcePage = {
  id: string;
  originalKey: string;
  workingKey: string;
  thumbKey: string;
  mimeType: string;
  width: number;
  height: number;
  byteSize: number;
  transform: Prisma.JsonValue;
  transformedAt: Date | null;
};

export type CopiedPage = SourcePage & { newId: string; newOriginalKey: string; newWorkingKey: string; newThumbKey: string };

const NOT_READY = "Wait for its pages to finish processing, then try again.";
const PAGE_FAILED = "A page of it couldn't be processed. Replace or delete that page first.";

/** The live pages of a document, in page order. Refuses unless every one is processed. */
export async function loadSourcePages(db: Db, documentId: string): Promise<SourcePage[]> {
  const photos = await db.photo.findMany({
    where: { documentId, deletedAt: null },
    orderBy: [{ pageIndex: "asc" }, { id: "asc" }],
    take: MAX_DOCUMENT_PAGES,
    select: {
      id: true,
      originalKey: true,
      workingKey: true,
      thumbKey: true,
      status: true,
      mimeType: true,
      width: true,
      height: true,
      byteSize: true,
      transform: true,
      transformedAt: true,
    },
  });
  if (photos.length === 0) throw new AppError("VALIDATION", "This document has no pages to copy.");
  return photos.map(({ status, workingKey, thumbKey, ...p }) => {
    if (status === "FAILED") throw new AppError("VALIDATION", PAGE_FAILED);
    if (status !== "DONE" || workingKey === null || thumbKey === null) throw new AppError("CONFLICT", NOT_READY);
    return { ...p, workingKey, thumbKey };
  });
}

/** Deterministic key for one copy action: the same click, retried, finds the copy it already made. */
export function copyKeyFor(action: "specimen" | "promote", sourceDocumentId: string, nonce: string): string {
  return `sha256:${createHash("sha256").update(`${action}\u0000${sourceDocumentId}\u0000${nonce}`).digest("hex")}`;
}

const COPY_PARALLEL = 8;

/** Copies every file a page owns to keys of new photo ids: original, base, working copy and thumbnail. */
export async function copyPageObjects(bookId: string, pages: SourcePage[]): Promise<CopiedPage[]> {
  const planned = pages.map((p) => {
    const newId = createId();
    return {
      ...p,
      newId,
      newOriginalKey: copiedOriginalKey(p.originalKey, createId()),
      newWorkingKey: copiedRenderKey(p.workingKey, p.id, newId),
      newThumbKey: copiedRenderKey(p.thumbKey, p.id, newId),
    };
  });
  const copies = planned.flatMap((p) => [
    [p.originalKey, p.newOriginalKey],
    // The base copy has no column: the crop editor re-renders from it at its derived path.
    [baseKey(bookId, p.id), baseKey(bookId, p.newId)],
    [p.workingKey, p.newWorkingKey],
    [p.thumbKey, p.newThumbKey],
  ] as const);
  try {
    for (let i = 0; i < copies.length; i += COPY_PARALLEL) {
      await Promise.all(copies.slice(i, i + COPY_PARALLEL).map(([from, to]) => copyObject(from, to)));
    }
  } catch (err) {
    // Every processed page has all four files, so a missing one means storage lost it; say so plainly.
    if ((err as { name?: string }).name === "NoSuchKey") {
      throw new AppError("CONFLICT", "A page's image is missing from storage, so it can't be copied. Replace that page first.");
    }
    throw err;
  }
  return planned;
}

/**
 * Writes the new document and its pages. The caller holds the book lock (positions) and has checked
 * ownership. `manualValues` travel: they were typed by a person and must not be lost.
 */
export async function insertCopiedDocument(
  tx: Db,
  input: {
    bookId: string;
    templateId: string;
    label: string | null;
    manualValues: Prisma.JsonValue | null;
    isSpecimen: boolean;
    copyKey: string;
    copiedFromDocumentId: string;
    pages: CopiedPage[];
  },
): Promise<string> {
  const doc = await tx.document.create({
    data: {
      bookId: input.bookId,
      templateId: input.templateId,
      label: input.label,
      position: await nextDocumentPosition(tx, input.bookId),
      isSpecimen: input.isSpecimen,
      manualValues: input.manualValues === null ? Prisma.DbNull : input.manualValues,
      copyKey: input.copyKey,
      copiedFromDocumentId: input.copiedFromDocumentId,
    },
    select: { id: true },
  });
  await tx.photo.createMany({
    data: input.pages.map((p, i) => ({
      id: p.newId,
      documentId: doc.id,
      pageIndex: i,
      originalKey: p.newOriginalKey,
      workingKey: p.newWorkingKey,
      thumbKey: p.newThumbKey,
      mimeType: p.mimeType,
      width: p.width,
      height: p.height,
      byteSize: p.byteSize,
      transform: p.transform === null ? Prisma.DbNull : p.transform,
      transformedAt: p.transformedAt,
      status: "DONE" as const,
    })),
  });
  return doc.id;
}

// ---------- the reading ----------

export type SourceRun = {
  id: string;
  model: string;
  promptVersion: string;
  passIndex: number;
  state: "QUEUED" | "RUNNING" | "PARTIAL" | "FAILED" | "COMPLETE" | "NEVER_RUN";
  startedAt: Date | null;
  finishedAt: Date | null;
  photoIds: string[];
  rawResponse: Prisma.JsonValue;
  createdAt: Date;
};

export type SourceValue = {
  fieldId: string;
  valueText: string | null;
  altValueText: string | null;
  state: "OK" | "ILLEGIBLE" | "EMPTY" | "DASH" | "NOT_APPLICABLE";
  isDitto: boolean;
  confidence: number | null;
  disagreement: boolean;
  photoId: string | null;
  bbox: Prisma.JsonValue;
};

export type SourceRecord = {
  id: string;
  runId: string;
  recordIndex: number;
  rowType: "DATA" | "HEADER" | "SUBTOTAL" | "TOTAL" | "NOTE";
  struckThrough: boolean;
  sequenceValue: string | null;
  photoId: string | null;
  bbox: Prisma.JsonValue;
  duplicateOf: string | null;
  values: SourceValue[];
};

export type ReadingCopy = {
  runs: (Omit<SourceRun, "rawResponse"> & { rawResponse: Prisma.JsonValue; idempotencyKey: string })[];
  records: (Omit<SourceRecord, "values">)[];
  values: (SourceValue & { rawRecordId: string })[];
};

/** Only the run summary travels: the full model responses are debugging data and stay with the original. */
function summaryOnly(rawResponse: Prisma.JsonValue): Prisma.JsonValue {
  if (rawResponse === null || typeof rawResponse !== "object" || Array.isArray(rawResponse)) return null;
  return Object.fromEntries(Object.entries(rawResponse).filter(([k]) => k !== "responses"));
}

/**
 * Plans the copy of a reading onto new pages, or returns null when it isn't a whole, finished reading of
 * exactly these pages — in which case the caller reads the copy again rather than copying something
 * partial. Pure: this decides what gets written, so it is the part under test.
 *
 * Every id is new; every page reference is remapped; every value is exactly as read (the raw layer).
 * Token counts are left off the copies, so usage and spend never count one model call twice.
 */
export function planReadingCopy(
  runs: SourceRun[],
  records: SourceRecord[],
  photoIdMap: ReadonlyMap<string, string>,
  newId: () => string = createId,
): ReadingCopy | null {
  const pageIds = [...photoIdMap.keys()];
  const current = currentRuns(pageIds, runs);
  if (current.length === 0 || current.some((r) => r.state !== "COMPLETE")) return null;
  const covered = new Set(current.flatMap((r) => r.photoIds));
  if (pageIds.some((id) => !covered.has(id))) return null;

  const mapPage = (id: string | null): string | null | undefined => (id === null ? null : photoIdMap.get(id));
  const runIds = new Map(current.map((r) => [r.id, newId()]));
  const recordIds = new Map(records.map((r) => [r.id, newId()]));

  const out: ReadingCopy = { runs: [], records: [], values: [] };
  for (const r of current) {
    const id = runIds.get(r.id);
    const photoIds = r.photoIds.map((p) => photoIdMap.get(p));
    if (id === undefined || photoIds.some((p) => p === undefined)) return null;
    out.runs.push({
      id,
      model: r.model,
      promptVersion: r.promptVersion,
      passIndex: r.passIndex,
      state: r.state,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      photoIds: photoIds.filter((p): p is string => p !== undefined),
      rawResponse: summaryOnly(r.rawResponse),
      createdAt: r.createdAt,
      idempotencyKey: `copy:${id}`,
    });
  }
  for (const rec of records) {
    const id = recordIds.get(rec.id);
    const runId = runIds.get(rec.runId);
    const photoId = mapPage(rec.photoId);
    const duplicateOf = rec.duplicateOf === null ? null : recordIds.get(rec.duplicateOf);
    // A record from a run that is no longer current, or on a page that isn't copied, is not this reading.
    if (id === undefined || runId === undefined || photoId === undefined || duplicateOf === undefined) return null;
    const { values, ...fields } = rec;
    out.records.push({ ...fields, id, runId, photoId, duplicateOf });
    for (const v of values) {
      const valuePhotoId = mapPage(v.photoId);
      if (valuePhotoId === undefined) return null;
      out.values.push({ ...v, rawRecordId: id, photoId: valuePhotoId });
    }
  }
  return out;
}

const INSERT_CHUNK = 1000;
const RUN_SCAN_LIMIT = 500;

/** Loads a document's reading in the shape `planReadingCopy` takes. */
export async function loadReading(db: Db, documentId: string): Promise<{ runs: SourceRun[]; records: SourceRecord[] }> {
  const [runs, records] = await Promise.all([
    db.extractionRun.findMany({
      where: { documentId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: RUN_SCAN_LIMIT,
      select: {
        id: true,
        model: true,
        promptVersion: true,
        passIndex: true,
        state: true,
        startedAt: true,
        finishedAt: true,
        photoIds: true,
        rawResponse: true,
        createdAt: true,
      },
    }),
    db.rawRecord.findMany({
      where: { documentId },
      orderBy: [{ recordIndex: "asc" }, { id: "asc" }],
      select: {
        id: true,
        runId: true,
        recordIndex: true,
        rowType: true,
        struckThrough: true,
        sequenceValue: true,
        photoId: true,
        bbox: true,
        duplicateOf: true,
        values: {
          select: {
            fieldId: true,
            valueText: true,
            altValueText: true,
            state: true,
            isDitto: true,
            confidence: true,
            disagreement: true,
            photoId: true,
            bbox: true,
          },
        },
      },
    }),
  ]);
  return { runs, records };
}

const json = (v: Prisma.JsonValue) => (v === null ? Prisma.DbNull : v);

/**
 * Writes a planned reading onto the new document, then derives its run state the way every reading's is
 * derived (`recomputeDocumentRun`). Rows and cells are not copied: the caller queues the transform, which
 * builds them for free.
 */
export async function insertReading(tx: Db, documentId: string, plan: ReadingCopy): Promise<void> {
  await tx.extractionRun.createMany({
    data: plan.runs.map((r) => ({ ...r, documentId, rawResponse: json(r.rawResponse), inputTokens: null, outputTokens: null, imageTokens: null, thinkingTokens: null })),
  });
  for (let i = 0; i < plan.records.length; i += INSERT_CHUNK) {
    await tx.rawRecord.createMany({
      data: plan.records.slice(i, i + INSERT_CHUNK).map((r) => ({ ...r, documentId, bbox: json(r.bbox) })),
    });
  }
  for (let i = 0; i < plan.values.length; i += INSERT_CHUNK) {
    await tx.rawValue.createMany({ data: plan.values.slice(i, i + INSERT_CHUNK).map((v) => ({ ...v, bbox: json(v.bbox) })) });
  }
  await recomputeDocumentRun(tx, documentId);
}
