import { createId } from "@paralleldrive/cuid2";
import { Prisma } from "@prisma/client";
import { generateNKeysBetween } from "fractional-indexing";
import { z } from "zod";

import { sortByPosition } from "@/lib/books/column-ops";
import { loadColumns } from "@/lib/books/columns-service";
import { prisma } from "@/lib/db/client";
import type { Db } from "@/lib/documents/access";
import { MAX_DOCUMENT_PAGES } from "@/lib/documents/schemas";
import { AppError } from "@/lib/errors";
import { extractionNeedsReview } from "@/lib/extraction/plan";
import { plural } from "@/lib/format";
import { log } from "@/lib/log";
import { MAX_MAPPINGS } from "@/lib/mappings/schemas";
import { mappingSelect, rowToTransformMapping } from "@/lib/mappings/views";
import { MAX_FIELDS, MAX_GROUPS } from "@/lib/templates/schemas";
import { fieldSelect, groupSelect, toFieldView } from "@/lib/templates/views";

import { parseDocumentFlags, type DocumentFlag } from "./flags";
import { planMerge, type ExistingRow, type MergePlan, type RowAnchor } from "./merge";
import { runTransform } from "./run";
import type { RawRecordInput, TransformInput } from "./types";

/**
 * Loads what the transform reads and writes what the merge decides (docs/03 §8). The worker runs it
 * after extraction and for rebuilds; the mapping preview reuses the loaders without writing.
 */

/** Rows read from, or built for, one document. Past this a build refuses rather than work from a partial list. */
const MAX_RECORDS_PER_DOCUMENT = 5000;

function tooMany(): never {
  throw new AppError(
    "VALIDATION",
    `This document has more than ${MAX_RECORDS_PER_DOCUMENT.toLocaleString("en-US")} rows, more than can be built at once. Split it into smaller documents.`,
  );
}
const MAX_TEMPLATE_TRANSFORM_DOCUMENTS = 10_000;
const CELL_WRITE_CHUNK = 500;

export type TemplateContext = Omit<TransformInput, "manualValues" | "records"> & { templateId: string; bookId: string };

export async function loadTemplateContext(db: Db, templateId: string): Promise<TemplateContext | null> {
  const template = await db.template.findFirst({
    where: { id: templateId, deletedAt: null, book: { deletedAt: null } },
    select: { id: true, bookId: true, kind: true, sequenceFieldId: true, book: { select: { numeralSystem: true, dateEra: true } } },
  });
  if (!template) return null;
  const groups = await db.fieldGroup.findMany({ where: { templateId }, select: groupSelect, take: MAX_GROUPS });
  const fields = await db.field.findMany({ where: { templateId, deletedAt: null }, select: fieldSelect, take: MAX_FIELDS });
  const columns = await loadColumns(db, template.bookId);
  const mappings = await db.mapping.findMany({ where: { templateId }, select: mappingSelect, take: MAX_MAPPINGS });
  return {
    templateId: template.id,
    bookId: template.bookId,
    kind: template.kind,
    sequenceFieldId: template.sequenceFieldId,
    groups,
    fields: fields.map(toFieldView),
    columns: columns.map((c) => ({ id: c.id, key: c.key, label: c.label, dataType: c.dataType, enumValues: c.enumValues, isRequired: c.isRequired })),
    mappings: sortByPosition(mappings).map(rowToTransformMapping),
    book: template.book,
  };
}

const manualValuesSchema = z.record(z.string(), z.string());

export function parseManualValues(value: Prisma.JsonValue | null): Record<string, string> {
  const parsed = manualValuesSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}

export type LoadedRecord = RawRecordInput & { duplicateOf: string | null };

/** The document's current raw records in reading order, each with the page it came from. */
export async function loadDocumentRecords(db: Db, documentId: string): Promise<LoadedRecord[]> {
  const photos = await db.photo.findMany({ where: { documentId }, select: { id: true, pageIndex: true }, take: MAX_DOCUMENT_PAGES });
  const pageOf = new Map(photos.map((p) => [p.id, p.pageIndex]));
  const records = await db.rawRecord.findMany({
    where: { documentId },
    orderBy: [{ recordIndex: "asc" }, { id: "asc" }],
    take: MAX_RECORDS_PER_DOCUMENT + 1,
    select: {
      id: true,
      recordIndex: true,
      rowType: true,
      struckThrough: true,
      photoId: true,
      duplicateOf: true,
      values: { select: { fieldId: true, valueText: true, state: true, isDitto: true, confidence: true }, take: MAX_FIELDS },
    },
  });
  if (records.length > MAX_RECORDS_PER_DOCUMENT) tooMany();
  return records.map(({ photoId, ...r }) => ({ ...r, pageIndex: photoId === null ? null : (pageOf.get(photoId) ?? null) }));
}

type StoredRow = ExistingRow & { position: string };

async function loadExistingRows(db: Db, documentId: string): Promise<StoredRow[]> {
  const rows = await db.row.findMany({
    where: { documentId },
    orderBy: { id: "asc" },
    take: MAX_RECORDS_PER_DOCUMENT + 1,
    select: {
      id: true,
      rawRecordId: true,
      recordKey: true,
      isVoid: true,
      voidReason: true,
      position: true,
      cells: {
        select: {
          id: true,
          outputColumnId: true,
          extractedValue: true,
          currentValue: true,
          state: true,
          isEdited: true,
          isReviewed: true,
          inherited: true,
          confidence: true,
          disagreement: true,
          validationState: true,
          validationMsgs: true,
        },
      },
    },
  });
  // A partial list would make the rows left out look gone, and the build would duplicate them.
  if (rows.length > MAX_RECORDS_PER_DOCUMENT) tooMany();
  return rows;
}

// ---------- positions ----------

async function positionAfter(tx: Db, bookId: string, position: string): Promise<string | null> {
  const rows = await tx.$queryRaw<{ position: string }[]>`
    SELECT position FROM "Row" WHERE "bookId" = ${bookId} AND position COLLATE "C" > ${position} COLLATE "C"
    ORDER BY position COLLATE "C" LIMIT 1`;
  return rows[0]?.position ?? null;
}

async function positionBefore(tx: Db, bookId: string, position: string): Promise<string | null> {
  const rows = await tx.$queryRaw<{ position: string }[]>`
    SELECT position FROM "Row" WHERE "bookId" = ${bookId} AND position COLLATE "C" < ${position} COLLATE "C"
    ORDER BY position COLLATE "C" DESC LIMIT 1`;
  return rows[0]?.position ?? null;
}

async function edgePosition(tx: Db, bookId: string, last: boolean): Promise<string | null> {
  const rows = last
    ? await tx.$queryRaw<{ position: string }[]>`SELECT position FROM "Row" WHERE "bookId" = ${bookId} ORDER BY position COLLATE "C" DESC LIMIT 1`
    : await tx.$queryRaw<{ position: string }[]>`SELECT position FROM "Row" WHERE "bookId" = ${bookId} ORDER BY position COLLATE "C" LIMIT 1`;
  return rows[0]?.position ?? null;
}

/** The last row of any document placed before this one, in the book's document order. */
async function documentLowerBound(tx: Db, doc: { id: string; bookId: string; position: string }): Promise<string | null> {
  const rows = await tx.$queryRaw<{ position: string }[]>`
    SELECT r.position FROM "Row" r JOIN "Document" d ON d.id = r."documentId"
    WHERE r."bookId" = ${doc.bookId} AND r."documentId" <> ${doc.id}
      AND (d.position COLLATE "C" < ${doc.position} COLLATE "C" OR (d.position = ${doc.position} AND d.id < ${doc.id}))
    ORDER BY r.position COLLATE "C" DESC LIMIT 1`;
  return rows[0]?.position ?? null;
}

/**
 * Keys for new rows: next to a row of the same document, or at the document's place among the others,
 * so a first extraction lands in document order. Manual order is canonical, so existing rows never move.
 */
async function newRowKeys(
  tx: Db,
  doc: { id: string; bookId: string; position: string },
  anchor: RowAnchor,
  count: number,
  positions: ReadonlyMap<string, string>,
): Promise<string[]> {
  let lo: string | null;
  let hi: string | null;
  if ("after" in anchor) {
    lo = positions.get(anchor.after) ?? null;
    hi = lo === null ? null : await positionAfter(tx, doc.bookId, lo);
  } else if ("before" in anchor) {
    hi = positions.get(anchor.before) ?? null;
    lo = hi === null ? null : await positionBefore(tx, doc.bookId, hi);
  } else {
    lo = await documentLowerBound(tx, doc);
    hi = lo === null ? await edgePosition(tx, doc.bookId, false) : await positionAfter(tx, doc.bookId, lo);
  }
  try {
    return generateNKeysBetween(lo, hi, count);
  } catch {
    // Neighbouring keys left no room (only after a collision): append at the end of the book instead.
    return generateNKeysBetween(await edgePosition(tx, doc.bookId, true), null, count);
  }
}

// ---------- writes ----------

async function writeCells(tx: Db, plan: MergePlan): Promise<void> {
  for (let i = 0; i < plan.cellCreates.length; i += CELL_WRITE_CHUNK) {
    await tx.cell.createMany({
      data: plan.cellCreates.slice(i, i + CELL_WRITE_CHUNK).map((c) => ({ rowId: c.rowId, outputColumnId: c.outputColumnId, ...c.values })),
      skipDuplicates: true,
    });
  }
  // `NOT isEdited` / `isEdited` guards: an edit saved while this ran is never overwritten.
  for (let i = 0; i < plan.autoCellUpdates.length; i += CELL_WRITE_CHUNK) {
    const values = plan.autoCellUpdates.slice(i, i + CELL_WRITE_CHUNK).map(
      ({ id, values: v }) =>
        Prisma.sql`(${id}, ${v.extractedValue}::text, ${v.currentValue}::text, ${v.state}::text, ${v.isReviewed}::boolean, ${v.inherited}::boolean, ${v.confidence}::float8, ${v.disagreement}::boolean, ${v.validationState}::text, ${v.validationMsgs}::text[])`,
    );
    await tx.$executeRaw`
      UPDATE "Cell" AS c SET
        "extractedValue" = v.ev, "currentValue" = v.cv, state = v.st::"ValueState", "isReviewed" = v.rv, inherited = v.inh,
        confidence = v.conf, disagreement = v.dis, "validationState" = v.vs::"ValidationState", "validationMsgs" = v.msgs, "updatedAt" = now()
      FROM (VALUES ${Prisma.join(values)}) AS v(id, ev, cv, st, rv, inh, conf, dis, vs, msgs)
      WHERE c.id = v.id AND NOT c."isEdited"`;
  }
  for (let i = 0; i < plan.editedCellUpdates.length; i += CELL_WRITE_CHUNK) {
    const values = plan.editedCellUpdates
      .slice(i, i + CELL_WRITE_CHUNK)
      .map((u) => Prisma.sql`(${u.id}, ${u.extractedValue}::text, ${u.disagreement}::boolean, ${u.isReviewed}::boolean)`);
    await tx.$executeRaw`
      UPDATE "Cell" AS c SET "extractedValue" = v.ev, disagreement = v.dis, "isReviewed" = v.rv, "updatedAt" = now()
      FROM (VALUES ${Prisma.join(values)}) AS v(id, ev, dis, rv)
      WHERE c.id = v.id AND c."isEdited"`;
  }
}

/** Writes the plan. Returns rows it kept as `ORPHANED` because an edit was saved after the plan was made. */
async function writePlan(tx: Db, doc: { id: string; bookId: string; position: string }, plan: MergePlan, existing: StoredRow[]): Promise<number> {
  let keptOrphans = 0;
  if (plan.rowDeletes.length > 0) {
    const { count } = await tx.row.deleteMany({ where: { id: { in: plan.rowDeletes }, cells: { none: { isEdited: true } } } });
    if (count < plan.rowDeletes.length) {
      // The rows the guard kept now hold edits: treat them like any edited row that no longer matches.
      const ids = { id: { in: plan.rowDeletes } };
      // A row whose void state still follows its rule becomes void; one someone changed by hand keeps their choice.
      await tx.row.updateMany({ where: { ...ids, isVoid: false, voidReason: null }, data: { isVoid: true } });
      const kept = await tx.row.updateMany({ where: ids, data: { rawRecordId: null, voidReason: "ORPHANED" } });
      keptOrphans = kept.count;
    }
  }
  for (const r of plan.rowUpdates) {
    await tx.row.update({ where: { id: r.id }, data: { rawRecordId: r.rawRecordId, recordKey: r.recordKey, isVoid: r.isVoid, voidReason: r.voidReason } });
  }
  const positions = new Map(existing.map((r) => [r.id, r.position]));
  for (const group of plan.newRowGroups) {
    const keys = await newRowKeys(tx, doc, group.anchor, group.rows.length, positions);
    await tx.row.createMany({
      data: group.rows.map((r, i) => {
        const position = keys[i];
        if (position === undefined) throw new Error(`Missing row key ${i} of ${keys.length}`);
        return { id: r.id, bookId: doc.bookId, documentId: doc.id, rawRecordId: r.rawRecordId, recordKey: r.recordKey, isVoid: r.isVoid, voidReason: r.voidReason, position };
      }),
    });
  }
  await writeCells(tx, plan);
  return keptOrphans;
}

/**
 * Records a problem that stopped a document's rows being rebuilt, so the document says so instead of
 * keeping stale rows silently. The next build that gets through replaces the flag.
 */
export async function flagBuildProblem(documentId: string, error: unknown): Promise<void> {
  const message = error instanceof AppError ? error.message : "Rows couldn't be rebuilt for this document. Press Rebuild rows to try again.";
  const doc = await prisma.document.findFirst({ where: { id: documentId, deletedAt: null }, select: { transformFlags: true } });
  if (!doc) return;
  const flags = [...parseDocumentFlags(doc.transformFlags).filter((f) => f.kind !== "BUILD_FAILED"), { kind: "BUILD_FAILED" as const, message }];
  await prisma.document.update({ where: { id: documentId }, data: { transformFlags: flags, needsReview: true } });
}

export type TransformOutcome =
  | { status: "skipped" }
  | { status: "done"; rows: number; created: number; deleted: number; orphaned: number; flags: number };

/**
 * Rebuilds one document's rows from its raw layer and merges them with what's stored. One
 * transaction under the book lock (positions) and the document lock (so two rebuilds of one document
 * can't interleave). Pass a template context to reuse it across a template rebuild.
 */
export async function transformDocument(documentId: string, context?: TemplateContext): Promise<TransformOutcome> {
  const target = await prisma.document.findFirst({ where: { id: documentId, deletedAt: null }, select: { bookId: true } });
  if (!target) return { status: "skipped" };

  return prisma.$transaction(
    async (tx): Promise<TransformOutcome> => {
      // Book, then document: the order document restructuring uses, so the locks can't deadlock.
      const book = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Book" WHERE id = ${target.bookId} AND "deletedAt" IS NULL FOR UPDATE`;
      if (book.length === 0) return { status: "skipped" };
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Document" WHERE id = ${documentId} AND "deletedAt" IS NULL FOR UPDATE`;
      if (locked.length === 0) return { status: "skipped" };
      const doc = await tx.document.findUniqueOrThrow({
        where: { id: documentId },
        select: { id: true, bookId: true, templateId: true, position: true, manualValues: true, contentState: true, templateMatchScore: true, transformFlags: true },
      });
      const ctx = context?.templateId === doc.templateId ? context : await loadTemplateContext(tx, doc.templateId);
      if (!ctx) return { status: "skipped" };

      const records = await loadDocumentRecords(tx, documentId);
      const existing = await loadExistingRows(tx, documentId);
      const extractionReview = extractionNeedsReview(doc.contentState, doc.templateMatchScore);
      if (records.length === 0 && existing.length === 0) {
        if (doc.transformFlags !== null) {
          await tx.document.update({ where: { id: documentId }, data: { transformFlags: Prisma.DbNull, needsReview: extractionReview } });
        }
        return { status: "done", rows: 0, created: 0, deleted: 0, orphaned: 0, flags: 0 };
      }

      const result = runTransform({ ...ctx, manualValues: parseManualValues(doc.manualValues), records });
      const plan = planMerge(result.rows, existing, createId);

      const duplicates = new Map(result.duplicates.map((d) => [d.recordId, d.duplicateOf]));
      for (const r of records) {
        const duplicateOf = duplicates.get(r.id) ?? null;
        if (r.duplicateOf !== duplicateOf) await tx.rawRecord.update({ where: { id: r.id }, data: { duplicateOf } });
      }
      const keptOrphans = await writePlan(tx, doc, plan, existing);

      const flags: DocumentFlag[] = [...result.flags];
      const orphaned = plan.orphanedRows.length + keptOrphans;
      if (orphaned > 0) {
        flags.push({
          kind: "ORPHANED_ROWS",
          message: `${plural(orphaned, "row")} with your edits ${orphaned === 1 ? "no longer matches" : "no longer match"} the extraction. ${orphaned === 1 ? "It is" : "They are"} kept, marked void.`,
        });
      }
      await tx.document.update({
        where: { id: documentId },
        data: { transformFlags: flags.length > 0 ? flags : Prisma.DbNull, needsReview: extractionReview || flags.length > 0 },
      });
      return {
        status: "done",
        rows: result.rows.length,
        created: plan.newRowGroups.reduce((n, g) => n + g.rows.length, 0),
        deleted: plan.rowDeletes.length,
        orphaned,
        flags: flags.length,
      };
    },
    { timeout: 60_000 },
  );
}

/**
 * Rebuilds every document of a template that has raw records or rows, in document order. A document
 * that fails is logged, counted in `failed` and skipped, so one bad document doesn't block the rest.
 *
 * The template context (fields, mappings, columns, book settings) is read once for the whole run. A
 * change saved mid-run leaves the documents already done on the old context; that is intended, because
 * the change also queues a follow-up rebuild (`keepLastIfActive`) that runs right after this one.
 */
export async function transformTemplate(
  templateId: string,
  onProgress?: (progress: { done: number; total: number }) => Promise<void>,
): Promise<{ documents: number; failed: number }> {
  const context = await loadTemplateContext(prisma, templateId);
  if (!context) return { documents: 0, failed: 0 };
  const docs = await prisma.$queryRaw<{ id: string }[]>`
    SELECT d.id FROM "Document" d
    WHERE d."templateId" = ${templateId} AND d."deletedAt" IS NULL
      AND (EXISTS (SELECT 1 FROM "RawRecord" r WHERE r."documentId" = d.id) OR EXISTS (SELECT 1 FROM "Row" w WHERE w."documentId" = d.id))
    ORDER BY d.position COLLATE "C", d.id
    LIMIT ${MAX_TEMPLATE_TRANSFORM_DOCUMENTS}`;
  let failed = 0;
  await onProgress?.({ done: 0, total: docs.length });
  for (const [i, d] of docs.entries()) {
    try {
      await transformDocument(d.id, context);
    } catch (err) {
      failed++;
      log.error("document transform failed", err, { templateId, documentId: d.id });
      await flagBuildProblem(d.id, err).catch((flagErr: unknown) => log.error("build problem not recorded", flagErr, { documentId: d.id }));
    }
    if ((i + 1) % 10 === 0 || i + 1 === docs.length) await onProgress?.({ done: i + 1, total: docs.length });
  }
  return { documents: docs.length, failed };
}
