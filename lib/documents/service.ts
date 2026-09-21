import { createId } from "@paralleldrive/cuid2";
import { Prisma } from "@prisma/client";
import { generateKeyBetween } from "fractional-indexing";

import { requireBookAccess } from "@/lib/auth/guards";
import { prisma } from "@/lib/db/client";
import type { Page } from "@/lib/db/pagination";
import { AppError } from "@/lib/errors";
import { currentRuns } from "@/lib/extraction/plan";
import { impactHash } from "@/lib/impact";
import { nextDocumentPosition } from "@/lib/photos/service";
import { photoSelect, toPhotoView, type PhotoView } from "@/lib/photos/views";
import { presignGet } from "@/lib/storage/s3";
import { requireTemplateAccess } from "@/lib/templates/access";
import { bboxSchema } from "@/lib/table/service";
import { parseDocumentFlags, type DocumentFlag } from "@/lib/transform/flags";
import { requestBookRevalidation, requestDocumentTransform } from "@/lib/transform/triggers";
import type { RowType, ValueState } from "@/lib/transform/types";
import type { FieldType, TemplateKind } from "@/lib/templates/schemas";
import { buildTree, flattenTree, formatPath, headerPath } from "@/lib/templates/tree";
import { fieldSelect, groupSelect, toFieldView } from "@/lib/templates/views";

import { assertNoExtractionOutput, lockBook, requireDocumentAccess, requireDocumentsAccess, type Db } from "./access";
import { isProblem, planGroup, planReorder, planSplit, type RestructurePlan } from "./restructure";
import { isStale, STALE_SQL } from "./staleness";
import {
  MAX_DOCUMENT_PAGES,
  type ContentState,
  type DeleteDocumentsInput,
  type GroupPhotosInput,
  type ListDocumentsInput,
  type MoveDocumentsInput,
  type MoveImpactInput,
  type ReorderPhotosInput,
  type RunState,
  type SplitDocumentInput,
  type UpdateDocumentInput,
} from "./schemas";

export type DocumentSummary = {
  id: string;
  label: string | null;
  templateId: string;
  templateName: string;
  templateKind: TemplateKind;
  pageCount: number;
  processingPages: number;
  failedPages: number;
  thumbUrl: string | null;
  runState: RunState;
  contentState: ContentState;
  needsReview: boolean;
  /** Phase 15: a page uploaded to build the template against, kept out of the book's output (decision 71). */
  isSpecimen: boolean;
  templateMatchScore: number | null;
  /** Review flags from building rows: sequence gaps, duplicates, flagged cells. */
  transformFlags: DocumentFlag[];
  rowCount: number;
  unreviewedCells: number;
  reviewedCells: number;
  /** Has cells to review and every one is reviewed (docs/01 §6.10). */
  reviewed: boolean;
  errorCells: number;
  hasEdits: boolean;
  editedCells: number;
  hasDisagreements: boolean;
  /** A page was transformed, replaced or added after the last successful reading (decision 58). */
  changedSinceLastRead: boolean;
  lastRunAt: string | null;
  /** When the document was last read successfully; null means it never was. */
  lastExtractedAt: string | null;
  lastModel: string | null;
  createdAt: string;
};

export type ManualFieldView = {
  id: string;
  labelSource: string;
  labelMeaning: string | null;
  path: string;
  dataType: FieldType;
};

export type RunView = {
  id: string;
  model: string;
  state: RunState;
  createdAt: string;
  finishedAt: string | null;
  error: string | null;
  /** 1-based page numbers this run covered (pages deleted since are left out). */
  pages: number[];
  photoIds: string[];
  /** A failed run that is still the latest reading of its pages. */
  retryable: boolean;
};

export type DocumentDetail = DocumentSummary & {
  bookId: string;
  languageHint: string | null;
  photos: PhotoView[];
  manualFields: ManualFieldView[];
  manualValues: Record<string, string>;
  runs: RunView[];
};

/** Runs listed in the drawer, plus any older run that is still the latest reading of a page. */
const RUN_HISTORY_LIMIT = 20;
const RUN_SCAN_LIMIT = 500;

// ---------- reads ----------

type CellStats = { documentId: string; rows: number; cells: number; unreviewed: number; errors: number; edited: number; disagreements: boolean };

async function loadSummaries(db: Db, ids: string[]): Promise<DocumentSummary[]> {
  if (ids.length === 0) return [];
  const [docs, photoGroups, stats] = await Promise.all([
    db.document.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        label: true,
        templateId: true,
        template: { select: { name: true, kind: true } },
        runState: true,
        contentState: true,
        needsReview: true,
        isSpecimen: true,
        templateMatchScore: true,
        transformFlags: true,
        contentChangedAt: true,
        lastExtractedAt: true,
        lastRunAt: true,
        lastModel: true,
        createdAt: true,
        photos: { where: { deletedAt: null }, orderBy: { pageIndex: "asc" }, take: 1, select: { thumbKey: true } },
      },
    }),
    db.photo.groupBy({ by: ["documentId", "status"], where: { documentId: { in: ids }, deletedAt: null }, _count: { _all: true } }),
    db.$queryRaw<CellStats[]>`
      SELECT r."documentId" AS "documentId",
             count(DISTINCT r.id)::int AS rows,
             count(c.id)::int AS cells,
             count(c.id) FILTER (WHERE NOT c."isReviewed")::int AS unreviewed,
             count(c.id) FILTER (WHERE c."validationState" = 'ERROR')::int AS errors,
             count(c.id) FILTER (WHERE c."isEdited")::int AS edited,
             coalesce(bool_or(c.disagreement), false) AS disagreements
      FROM "Row" r
      LEFT JOIN "OutputColumn" oc ON oc."bookId" = r."bookId" AND oc."deletedAt" IS NULL
      LEFT JOIN "Cell" c ON c."rowId" = r.id AND c."outputColumnId" = oc.id
      WHERE r."documentId" IN (${Prisma.join(ids)}) AND NOT r."isVoid" AND r."deletedAt" IS NULL
      GROUP BY r."documentId"`,
  ]);
  const pages = new Map<string, { total: number; processing: number; failed: number }>();
  for (const g of photoGroups) {
    const p = pages.get(g.documentId) ?? { total: 0, processing: 0, failed: 0 };
    p.total += g._count._all;
    if (g.status === "FAILED") p.failed += g._count._all;
    else if (g.status !== "DONE") p.processing += g._count._all;
    pages.set(g.documentId, p);
  }
  const statsById = new Map(stats.map((s) => [s.documentId, s]));
  const byId = new Map(docs.map((d) => [d.id, d]));
  const thumbUrls = new Map(
    await Promise.all(
      docs.map(async (d) => {
        const key = d.photos[0]?.thumbKey;
        return [d.id, key ? await presignGet(key) : null] as const;
      }),
    ),
  );
  const out: DocumentSummary[] = [];
  for (const id of ids) {
    const d = byId.get(id);
    if (!d) continue;
    const p = pages.get(id) ?? { total: 0, processing: 0, failed: 0 };
    const s = statsById.get(id);
    out.push({
      id: d.id,
      label: d.label,
      templateId: d.templateId,
      templateName: d.template.name,
      templateKind: d.template.kind,
      pageCount: p.total,
      processingPages: p.processing,
      failedPages: p.failed,
      thumbUrl: thumbUrls.get(id) ?? null,
      runState: d.runState,
      contentState: d.contentState,
      needsReview: d.needsReview,
      isSpecimen: d.isSpecimen,
      templateMatchScore: d.templateMatchScore,
      transformFlags: parseDocumentFlags(d.transformFlags),
      rowCount: s?.rows ?? 0,
      unreviewedCells: s?.unreviewed ?? 0,
      reviewedCells: (s?.cells ?? 0) - (s?.unreviewed ?? 0),
      reviewed: (s?.cells ?? 0) > 0 && s?.unreviewed === 0,
      errorCells: s?.errors ?? 0,
      hasEdits: (s?.edited ?? 0) > 0,
      editedCells: s?.edited ?? 0,
      hasDisagreements: s?.disagreements ?? false,
      changedSinceLastRead: isStale(d),
      lastRunAt: d.lastRunAt?.toISOString() ?? null,
      lastExtractedAt: d.lastExtractedAt?.toISOString() ?? null,
      lastModel: d.lastModel,
      createdAt: d.createdAt.toISOString(),
    });
  }
  return out;
}

function encodeCursor(position: string, id: string): string {
  return `${position}_${id}`;
}

function decodeCursor(cursor: string): { position: string; id: string } {
  const at = cursor.indexOf("_");
  const position = cursor.slice(0, at);
  const id = cursor.slice(at + 1);
  if (at <= 0 || !/^[0-9A-Za-z]+$/.test(position) || !/^[a-z0-9]+$/.test(id)) {
    throw new AppError("VALIDATION", "That page of documents is out of date. Reload the list.");
  }
  return { position, id };
}

/** Documents in manual order (`position`, code-unit collation), filtered, keyset-paginated. */
export async function listDocuments(userId: string, bookId: string, input: ListDocumentsInput): Promise<Page<DocumentSummary>> {
  await requireBookAccess(userId, bookId);
  const conds: Prisma.Sql[] = [
    Prisma.sql`d."bookId" = ${bookId}`,
    Prisma.sql`d."deletedAt" IS NULL`,
    Prisma.sql`t."deletedAt" IS NULL`,
  ];
  if (input.templateId) conds.push(Prisma.sql`d."templateId" = ${input.templateId}`);
  if (input.runState) conds.push(Prisma.sql`d."runState" = ${input.runState}::"RunState"`);
  if (input.needsReview !== undefined) conds.push(Prisma.sql`d."needsReview" = ${input.needsReview}`);
  if (input.hasEdits !== undefined) {
    const edited = Prisma.sql`EXISTS (SELECT 1 FROM "Row" r JOIN "Cell" c ON c."rowId" = r.id WHERE r."documentId" = d.id AND r."deletedAt" IS NULL AND c."isEdited")`;
    conds.push(input.hasEdits ? edited : Prisma.sql`NOT ${edited}`);
  }
  if (input.reviewed !== undefined) {
    // Same rows and cells the table counts: live, non-void rows; cells of live columns.
    const rowsToReview = Prisma.sql`SELECT 1 FROM "Row" r JOIN "Cell" c ON c."rowId" = r.id JOIN "OutputColumn" oc ON oc.id = c."outputColumnId" AND oc."deletedAt" IS NULL
      WHERE r."documentId" = d.id AND r."deletedAt" IS NULL AND NOT r."isVoid"`;
    const unreviewed = Prisma.sql`SELECT 1 FROM "Row" r JOIN "Cell" c ON c."rowId" = r.id JOIN "OutputColumn" oc ON oc.id = c."outputColumnId" AND oc."deletedAt" IS NULL
      WHERE r."documentId" = d.id AND r."deletedAt" IS NULL AND NOT r."isVoid" AND NOT c."isReviewed"`;
    conds.push(
      input.reviewed
        ? Prisma.sql`EXISTS (${rowsToReview}) AND NOT EXISTS (${unreviewed})`
        : Prisma.sql`(NOT EXISTS (${rowsToReview}) OR EXISTS (${unreviewed}))`,
    );
  }
  if (input.needsReextraction !== undefined) {
    conds.push(input.needsReextraction ? STALE_SQL : Prisma.sql`NOT ${STALE_SQL}`);
  }
  if (input.q) {
    const pattern = `%${input.q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    conds.push(Prisma.sql`d.label ILIKE ${pattern}`);
  }
  if (input.cursor) {
    const { position, id } = decodeCursor(input.cursor);
    conds.push(
      Prisma.sql`(d.position COLLATE "C" > ${position} COLLATE "C" OR (d.position = ${position} AND d.id > ${id}))`,
    );
  }
  const rows = await prisma.$queryRaw<{ id: string; position: string }[]>`
    SELECT d.id, d.position FROM "Document" d JOIN "Template" t ON t.id = d."templateId"
    WHERE ${Prisma.join(conds, " AND ")}
    ORDER BY d.position COLLATE "C", d.id
    LIMIT ${input.limit + 1}`;
  const pageRows = rows.slice(0, input.limit);
  const last = pageRows.at(-1);
  const nextCursor = rows.length > input.limit && last ? encodeCursor(last.position, last.id) : null;
  return { items: await loadSummaries(prisma, pageRows.map((r) => r.id)), nextCursor };
}

function parseManualValues(value: Prisma.JsonValue | null): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) if (typeof v === "string") out[k] = v;
  return out;
}

async function loadManualFields(db: Db, templateId: string): Promise<ManualFieldView[]> {
  const [groups, fields] = await Promise.all([
    db.fieldGroup.findMany({ where: { templateId }, select: groupSelect, take: 500 }),
    db.field.findMany({ where: { templateId, deletedAt: null }, select: fieldSelect, take: 2000 }),
  ]);
  const tree = buildTree(groups, fields);
  return flattenTree(tree).flatMap((node) =>
    node.kind === "field" && node.field.mode === "MANUAL"
      ? [
          {
            id: node.id,
            labelSource: node.field.labelSource,
            labelMeaning: node.field.labelMeaning,
            path: formatPath(headerPath(tree, { kind: "field", id: node.id })),
            dataType: node.field.dataType,
          },
        ]
      : [],
  );
}

async function loadDetail(db: Db, documentId: string): Promise<DocumentDetail> {
  const [summary] = await loadSummaries(db, [documentId]);
  if (!summary) throw new AppError("NOT_FOUND", "That document doesn't exist or was deleted.");
  const doc = await db.document.findUniqueOrThrow({
    where: { id: documentId },
    select: {
      bookId: true,
      manualValues: true,
      template: { select: { languageHint: true } },
      photos: { where: { deletedAt: null }, orderBy: [{ pageIndex: "asc" }, { id: "asc" }], select: photoSelect, take: MAX_DOCUMENT_PAGES },
    },
  });
  // Current runs are worked out over many runs, not just the history shown: a page's latest run can be
  // older than the most recent ones when other pages were retried often.
  const allRuns = await db.extractionRun.findMany({
    where: { documentId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: RUN_SCAN_LIMIT,
    select: { id: true, model: true, state: true, createdAt: true, finishedAt: true, error: true, photoIds: true },
  });
  const pageOf = new Map(doc.photos.map((p) => [p.id, p.pageIndex + 1]));
  const current = new Set(currentRuns(doc.photos.map((p) => p.id), allRuns).map((r) => r.id));
  const shownRuns = allRuns.filter((r, i) => i < RUN_HISTORY_LIMIT || current.has(r.id));
  const active = summary.runState === "QUEUED" || summary.runState === "RUNNING";
  return {
    ...summary,
    bookId: doc.bookId,
    languageHint: doc.template.languageHint,
    photos: await Promise.all(doc.photos.map(toPhotoView)),
    manualFields: await loadManualFields(db, summary.templateId),
    manualValues: parseManualValues(doc.manualValues),
    runs: shownRuns.map((r) => ({
      id: r.id,
      model: r.model,
      state: r.state,
      createdAt: r.createdAt.toISOString(),
      finishedAt: r.finishedAt?.toISOString() ?? null,
      error: r.error,
      pages: r.photoIds.flatMap((id) => {
        const page = pageOf.get(id);
        return page === undefined ? [] : [page];
      }),
      photoIds: r.photoIds,
      retryable: !active && r.state === "FAILED" && current.has(r.id),
    })),
  };
}

export async function getDocument(userId: string, documentId: string): Promise<DocumentDetail> {
  await requireDocumentAccess(userId, documentId);
  return loadDetail(prisma, documentId);
}

/** What the AI read, page by page, before any mapping: the first thing anyone sees of a reading. */


export type RawValueView = {
  fieldId: string;
  label: string;
  /** The field as it reads on the paper, header path included. */
  path: string;
  valueText: string | null;
  state: ValueState;
  isDitto: boolean;
  confidence: number | null;
  photoId: string | null;
  bbox: { x: number; y: number; w: number; h: number } | null;
};

export type RawRecordView = {
  id: string;
  recordIndex: number;
  rowType: RowType;
  struckThrough: boolean;
  photoId: string | null;
  values: RawValueView[];
};

export type DocumentRawValues = {
  documentId: string;
  label: string | null;
  templateKind: TemplateKind;
  contentState: ContentState;
  records: RawRecordView[];
  /** Records beyond `RAW_RECORD_LIMIT` are not returned; the reading itself keeps all of them. */
  totalRecords: number;
};

const RAW_RECORD_LIMIT = 50;
const RAW_VALUE_LIMIT = 1000;

/**
 * The document's current raw records, in template order (docs/02 → Raw layer) — the same records the
 * transform reads, replaced page by page as a page is read again. Read-only and mapping-free on
 * purpose: `Try one document` shows it before any column exists (docs/06 Phase 10).
 */
export async function getDocumentRawValues(userId: string, documentId: string): Promise<DocumentRawValues> {
  const { templateId } = await requireDocumentAccess(userId, documentId);
  const [doc, groups, fields, records] = await Promise.all([
    prisma.document.findUniqueOrThrow({
      where: { id: documentId },
      select: { label: true, contentState: true, template: { select: { kind: true } } },
    }),
    prisma.fieldGroup.findMany({ where: { templateId }, select: groupSelect }),
    prisma.field.findMany({ where: { templateId }, select: fieldSelect }),
    prisma.rawRecord.findMany({
      where: { documentId },
      orderBy: [{ recordIndex: "asc" }, { id: "asc" }],
      take: RAW_RECORD_LIMIT,
      select: {
        id: true,
        recordIndex: true,
        rowType: true,
        struckThrough: true,
        photoId: true,
        values: {
          select: { fieldId: true, valueText: true, state: true, isDitto: true, confidence: true, photoId: true, bbox: true },
          take: RAW_VALUE_LIMIT,
        },
      },
    }),
  ]);
  const totalRecords = await prisma.rawRecord.count({ where: { documentId } });

  const tree = buildTree(groups, fields.map(toFieldView));
  // Template order, so a value sits where the operator's eye already is on the paper.
  const order = new Map(flattenTree(tree).flatMap((n, i) => (n.kind === "field" ? [[n.id, i] as const] : [])));
  const labels = new Map(fields.map((f) => [f.id, { label: f.labelMeaning ?? f.labelSource, path: formatPath(headerPath(tree, { kind: "field", id: f.id })) }]));

  return {
    documentId,
    label: doc.label,
    templateKind: doc.template.kind,
    contentState: doc.contentState,
    totalRecords,
    records: records.map((r) => ({
      id: r.id,
      recordIndex: r.recordIndex,
      rowType: r.rowType,
      struckThrough: r.struckThrough,
      photoId: r.photoId,
      values: r.values
        .map((v): RawValueView => {
          const bbox = bboxSchema.safeParse(v.bbox);
          const known = labels.get(v.fieldId);
          return {
            fieldId: v.fieldId,
            // A value of a field deleted since the reading is kept, so it is named rather than hidden.
            label: known?.label ?? "Deleted field",
            path: known?.path ?? "Deleted field",
            valueText: v.valueText,
            state: v.state,
            isDitto: v.isDitto,
            confidence: v.confidence,
            photoId: v.photoId,
            bbox: bbox.success ? bbox.data : null,
          };
        })
        .sort((a, b) => (order.get(a.fieldId) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.fieldId) ?? Number.MAX_SAFE_INTEGER)),
    })),
  };
}

// ---------- edits ----------

/**
 * Label and MANUAL-mode values. Values are stored exactly as typed (no trimming or conversion);
 * `null` clears one. Only live MANUAL fields of the document's template accept a value.
 */
export async function updateDocument(userId: string, documentId: string, input: UpdateDocumentInput): Promise<DocumentDetail> {
  const { templateId } = await requireDocumentAccess(userId, documentId);
  const detail = await prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ manualValues: Prisma.JsonValue | null; bookId: string; isSpecimen: boolean }[]>`
      SELECT "manualValues", "bookId", "isSpecimen" FROM "Document" WHERE id = ${documentId} AND "deletedAt" IS NULL FOR UPDATE`;
    const row = locked[0];
    if (!row) throw new AppError("NOT_FOUND", "That document doesn't exist or was deleted.");
    const data: Prisma.DocumentUpdateInput = {};
    if (input.label !== undefined) data.label = input.label;
    if (input.isSpecimen !== undefined) data.isSpecimen = input.isSpecimen;
    if (input.manualValues !== undefined) {
      const setting = Object.entries(input.manualValues).filter(([, v]) => v !== null);
      if (setting.length > 0) {
        const manual = await tx.field.findMany({
          where: { templateId, deletedAt: null, mode: "MANUAL", id: { in: setting.map(([k]) => k) } },
          select: { id: true },
        });
        if (manual.length !== setting.length) {
          throw new AppError("VALIDATION", "One of these fields is no longer typed by hand. Reload the document.");
        }
      }
      const next = parseManualValues(row.manualValues);
      for (const [fieldId, value] of Object.entries(input.manualValues)) {
        if (value === null) delete next[fieldId];
        else next[fieldId] = value;
      }
      data.manualValues = Object.keys(next).length === 0 ? Prisma.DbNull : next;
    }
    await tx.document.update({ where: { id: documentId }, data });
    return { detail: await loadDetail(tx, documentId), bookId: row.bookId, specimenChanged: input.isSpecimen !== undefined && input.isSpecimen !== row.isSpecimen };
  });
  // Manual values fill cells of every row of the document.
  if (input.manualValues !== undefined) await requestDocumentTransform(documentId);
  /*
   * Promoting or demoting a specimen moves its rows in or out of everything the book counts, and
   * `UNIQUE` rules are the one check that reads across rows: a value that was unique while the
   * specimen's rows were out of scope may not be once they are in it. Nothing is rebuilt — the rows
   * already exist — so this is a re-check, not a re-extraction (decision 71).
   */
  if (detail.specimenChanged) await requestBookRevalidation(detail.bookId);
  return detail.detail;
}

async function applyPlan(tx: Db, plan: RestructurePlan): Promise<void> {
  const current = await tx.photo.findMany({
    where: { id: { in: plan.assignments.map((a) => a.photoId) }, deletedAt: null },
    select: { id: true, documentId: true, pageIndex: true },
  });
  const byId = new Map(current.map((p) => [p.id, p]));
  for (const a of plan.assignments) {
    const p = byId.get(a.photoId);
    if (!p) throw new Error(`photo ${a.photoId} vanished under the book lock`);
    if (p.documentId !== a.documentId || p.pageIndex !== a.pageIndex) {
      await tx.photo.update({ where: { id: a.photoId }, data: { documentId: a.documentId, pageIndex: a.pageIndex } });
    }
  }
  if (plan.emptied.length > 0) {
    await tx.document.updateMany({ where: { id: { in: plan.emptied } }, data: { deletedAt: new Date() } });
  }
}

async function pagesOf(tx: Db, documentIds: string[]): Promise<{ documentId: string; photoIds: string[] }[]> {
  const photos = await tx.photo.findMany({
    where: { documentId: { in: documentIds }, deletedAt: null },
    orderBy: [{ pageIndex: "asc" }, { id: "asc" }],
    select: { id: true, documentId: true },
  });
  return documentIds.map((documentId) => ({
    documentId,
    photoIds: photos.filter((p) => p.documentId === documentId).map((p) => p.id),
  }));
}

/**
 * Groups photos into one document (the document of the first listed photo), pages in the listed
 * order. Documents left without photos are deleted. All photos must be on documents of `templateId`.
 */
export async function groupPhotos(
  userId: string,
  templateId: string,
  input: GroupPhotosInput,
): Promise<{ documentId: string; removedDocuments: number }> {
  const { bookId } = await requireTemplateAccess(userId, templateId);
  return prisma.$transaction(async (tx) => {
    await lockBook(tx, bookId);
    const unique = [...new Set(input.photoIds)];
    const photos = await tx.photo.findMany({
      where: { id: { in: unique }, deletedAt: null },
      select: { id: true, documentId: true, document: { select: { bookId: true, templateId: true, deletedAt: true } } },
    });
    if (photos.length !== unique.length || photos.some((p) => p.document.bookId !== bookId || p.document.deletedAt !== null)) {
      throw new AppError("NOT_FOUND", "Some of these photos were deleted. Reload and try again.");
    }
    if (photos.some((p) => p.document.templateId !== templateId)) {
      throw new AppError("VALIDATION", "Only documents of the same template can be grouped. Move them to one template first.");
    }
    const documentIds = [...new Set(photos.map((p) => p.documentId))];
    await assertNoExtractionOutput(tx, documentIds, "group");
    const plan = planGroup(await pagesOf(tx, documentIds), input.photoIds);
    if (isProblem(plan)) throw new AppError("VALIDATION", plan.problem);
    const first = plan.assignments.find((a) => a.photoId === input.photoIds[0]);
    if (!first) throw new Error("group target missing from plan");
    if (plan.assignments.filter((a) => a.documentId === first.documentId).length > MAX_DOCUMENT_PAGES) {
      throw new AppError("VALIDATION", `A document can have at most ${MAX_DOCUMENT_PAGES} pages.`);
    }
    await applyPlan(tx, plan);
    return { documentId: first.documentId, removedDocuments: plan.emptied.length };
  });
}

/** Moves the chosen pages into a new document placed right after this one. */
export async function splitDocument(userId: string, documentId: string, input: SplitDocumentInput): Promise<{ documentId: string }> {
  const { bookId } = await requireDocumentAccess(userId, documentId);
  return prisma.$transaction(async (tx) => {
    await lockBook(tx, bookId);
    await requireDocumentAccess(userId, documentId, tx);
    await assertNoExtractionOutput(tx, [documentId], "split");
    const [pages] = await pagesOf(tx, [documentId]);
    if (!pages) throw new Error("document pages missing");
    const newId = createId();
    const plan = planSplit(pages, input.photoIds, newId);
    if (isProblem(plan)) throw new AppError("VALIDATION", plan.problem);

    const doc = await tx.document.findUniqueOrThrow({
      where: { id: documentId },
      select: { templateId: true, batchId: true, label: true, position: true },
    });
    const next = await tx.$queryRaw<{ position: string }[]>`
      SELECT position FROM "Document"
      WHERE "bookId" = ${bookId} AND position COLLATE "C" > ${doc.position} COLLATE "C"
      ORDER BY position COLLATE "C" LIMIT 1`;
    let position: string;
    try {
      position = generateKeyBetween(doc.position, next[0]?.position ?? null);
    } catch {
      position = await nextDocumentPosition(tx, bookId);
    }
    await tx.document.create({
      data: {
        id: newId,
        bookId,
        templateId: doc.templateId,
        batchId: doc.batchId,
        label: doc.label ? `${doc.label} (split)` : null,
        position,
      },
    });
    await applyPlan(tx, plan);
    return { documentId: newId };
  });
}

export async function reorderPhotos(userId: string, documentId: string, input: ReorderPhotosInput): Promise<DocumentDetail> {
  const { bookId } = await requireDocumentAccess(userId, documentId);
  return prisma.$transaction(async (tx) => {
    await lockBook(tx, bookId);
    await requireDocumentAccess(userId, documentId, tx);
    const [pages] = await pagesOf(tx, [documentId]);
    if (!pages) throw new Error("document pages missing");
    const plan = planReorder(pages, input.photoIds);
    if (isProblem(plan)) throw new AppError("CONFLICT", plan.problem);
    const changed = pages.photoIds.some((id, i) => input.photoIds[i] !== id);
    if (changed) {
      await assertNoExtractionOutput(tx, [documentId], "reorder the pages of");
      await applyPlan(tx, plan);
    }
    return loadDetail(tx, documentId);
  });
}

// ---------- delete ----------

export type DocumentsDeleteImpact = {
  impactHash: string;
  documents: number;
  photos: number;
  rows: number;
  editedCells: number;
};

export async function documentsDeleteImpact(userId: string, ids: string[], db: Db = prisma): Promise<DocumentsDeleteImpact> {
  await requireDocumentsAccess(userId, ids, db);
  const unique = [...new Set(ids)].sort();
  const where = { documentId: { in: unique } };
  const liveRows = { ...where, deletedAt: null };
  const [photos, rows, editedCells] = await Promise.all([
    db.photo.count({ where }),
    db.row.count({ where: liveRows }),
    db.cell.count({ where: { isEdited: true, row: liveRows } }),
  ]);
  const counts = { documents: unique.length, photos, rows, editedCells };
  return { impactHash: impactHash({ action: "documents.delete", ids: unique, ...counts }), ...counts };
}

/** Soft-deletes documents. Photos, raw values and rows stay with them. */
export async function deleteDocuments(userId: string, input: DeleteDocumentsInput): Promise<{ deleted: number }> {
  const { bookId } = await requireDocumentsAccess(userId, input.ids);
  return prisma.$transaction(async (tx) => {
    await lockBook(tx, bookId);
    const impact = await documentsDeleteImpact(userId, input.ids, tx);
    if (impact.impactHash !== input.impactHash) {
      throw new AppError("CONFLICT", "These documents changed since you reviewed the deletion. Review it again.");
    }
    const { count } = await tx.document.updateMany({
      where: { id: { in: input.ids }, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    return { deleted: count };
  });
}

// ---------- move ----------

export type DocumentsMoveImpact = {
  impactHash: string;
  targetTemplateName: string;
  documents: number;
  alreadyOnTarget: number;
  photos: number;
  rawValues: number;
  rows: number;
  cells: number;
  editedCells: number;
  reviewedCells: number;
  manualValueDocuments: number;
};

async function computeMoveImpact(userId: string, input: MoveImpactInput, db: Db): Promise<{ impact: DocumentsMoveImpact; moving: string[] }> {
  const { bookId, documents } = await requireDocumentsAccess(userId, input.ids, db);
  const target = await requireTemplateAccess(userId, input.targetTemplateId, db);
  if (target.bookId !== bookId) throw new AppError("NOT_FOUND", "That template isn't in this book.");
  const moving = documents.filter((d) => d.templateId !== target.id).map((d) => d.id).sort();
  if (moving.length === 0) throw new AppError("VALIDATION", "These documents already use that template.");
  const where = { documentId: { in: moving } };
  const extracting = await db.document.count({ where: { id: { in: moving }, runState: { in: ["QUEUED", "RUNNING"] } } });
  if (extracting > 0) {
    throw new AppError(
      "CONFLICT",
      `${extracting === 1 ? "1 of these documents is" : `${extracting} of these documents are`} being extracted. Wait for extraction to finish before moving them.`,
    );
  }
  const [template, photos, rawValues, rows, cells, editedCells, reviewedCells, manualValueDocuments] = await Promise.all([
    db.template.findUniqueOrThrow({ where: { id: target.id }, select: { name: true } }),
    db.photo.count({ where }),
    db.rawValue.count({ where: { record: where } }),
    db.row.count({ where: { ...where, deletedAt: null } }),
    db.cell.count({ where: { row: { ...where, deletedAt: null } } }),
    db.cell.count({ where: { isEdited: true, row: { ...where, deletedAt: null } } }),
    db.cell.count({ where: { isReviewed: true, row: { ...where, deletedAt: null } } }),
    db.document.count({ where: { id: { in: moving }, manualValues: { not: Prisma.DbNull } } }),
  ]);
  const counts = {
    targetTemplateName: template.name,
    documents: moving.length,
    alreadyOnTarget: documents.length - moving.length,
    photos,
    rawValues,
    rows,
    cells,
    editedCells,
    reviewedCells,
    manualValueDocuments,
  };
  return {
    impact: { impactHash: impactHash({ action: "documents.move", moving, target: target.id, ...counts }), ...counts },
    moving,
  };
}

export async function documentsMoveImpact(userId: string, input: MoveImpactInput): Promise<DocumentsMoveImpact> {
  return (await computeMoveImpact(userId, input, prisma)).impact;
}

/**
 * Moves documents to another template in the same book. Field ids differ between templates, so
 * the raw layer, derived rows and MANUAL values are discarded and the documents return to
 * `NEVER_RUN`. Photos, page order and batch stay. Run history is kept.
 */
export async function moveDocuments(userId: string, input: MoveDocumentsInput): Promise<{ moved: number }> {
  const { bookId } = await requireDocumentsAccess(userId, input.ids);
  return prisma.$transaction(async (tx) => {
    await lockBook(tx, bookId);
    const { impact, moving } = await computeMoveImpact(userId, input, tx);
    if (impact.impactHash !== input.impactHash) {
      throw new AppError("CONFLICT", "These documents changed since you reviewed the move. Review it again.");
    }
    await tx.rawRecord.deleteMany({ where: { documentId: { in: moving } } });
    await tx.row.deleteMany({ where: { documentId: { in: moving } } });
    await tx.document.updateMany({
      where: { id: { in: moving } },
      data: {
        templateId: input.targetTemplateId,
        runState: "NEVER_RUN",
        contentState: "UNKNOWN",
        templateMatchScore: null,
        needsReview: false,
        transformFlags: Prisma.DbNull,
        lastRunAt: null,
        lastModel: null,
        manualValues: Prisma.DbNull,
      },
    });
    return { moved: moving.length };
  });
}
