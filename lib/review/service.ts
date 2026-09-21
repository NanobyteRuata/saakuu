import { Prisma } from "@prisma/client";

import { requireBookAccess, requireUserId } from "@/lib/auth/guards";
import { prisma } from "@/lib/db/client";
import { COUNTING_DOC_TEMPLATE_SQL } from "@/lib/db/scope";
import type { Db } from "@/lib/documents/access";
import { AppError } from "@/lib/errors";
import { decodeCursor, encodeCursor } from "@/lib/table/cursor";
import { bboxSchema, liveRow } from "@/lib/table/service";
import { buildTree } from "@/lib/templates/tree";
import { firstWorkingMappings } from "@/lib/transform/run";
import { loadTemplateContext } from "@/lib/transform/service";

import type { ReviewQueueInput } from "./schemas";
import { cellSources, type RegionValue } from "./sources";
import type { ResumePoint, ReviewProgress, ReviewQueuePage, RowSources } from "./types";

/**
 * Row review (docs/05 §13): where each cell was read, what is left to review and how far along a book is.
 * Review covers live, non-void rows of live documents and templates, and cells of live columns: the same
 * rows and cells the table counts.
 */

const MAX_VALUES_PER_RECORD = 1000;

/** Where a row and each of its cells were read on the source photo. */
export async function getRowSources(userId: string, rowId: string): Promise<RowSources> {
  const uid = requireUserId(userId);
  const row = await prisma.row.findFirst({
    where: { id: rowId, ...liveRow(uid) },
    select: { id: true, rawRecordId: true, document: { select: { templateId: true } }, rawRecord: { select: { photoId: true, bbox: true } } },
  });
  if (!row) throw new AppError("NOT_FOUND", "That row doesn't exist any more. Refresh the table.");
  const recordBbox = bboxSchema.safeParse(row.rawRecord?.bbox);
  const base = { rowId: row.id, photoId: row.rawRecord?.photoId ?? null, bbox: recordBbox.success ? recordBbox.data : null };
  if (!row.rawRecordId) return { ...base, cells: {} };

  const [ctx, values] = await Promise.all([
    loadTemplateContext(prisma, row.document.templateId),
    prisma.rawValue.findMany({ where: { rawRecordId: row.rawRecordId }, select: { fieldId: true, photoId: true, bbox: true, valueText: true }, take: MAX_VALUES_PER_RECORD }),
  ]);
  if (!ctx) return { ...base, cells: {} };
  const tree = buildTree(ctx.groups, ctx.fields);
  const working = firstWorkingMappings(ctx.mappings, { tree, liveColumnIds: new Set(ctx.columns.map((c) => c.id)) });
  const regions = values.map((v): RegionValue => {
    const bbox = bboxSchema.safeParse(v.bbox);
    return { fieldId: v.fieldId, photoId: v.photoId, bbox: bbox.success ? bbox.data : null, valueText: v.valueText };
  });
  return { ...base, cells: cellSources(tree, working, regions, base.photoId) };
}

type ProgressRecord = { bookId: string; cells: number; reviewedCells: number; documents: number; reviewedDocuments: number };

const NO_PROGRESS: ReviewProgress = { cells: 0, reviewedCells: 0, documents: 0, reviewedDocuments: 0 };

/**
 * Cells reviewed and documents complete, per book, in one pass. A document counts once it has a row to review; it is
 * complete when every cell is reviewed. The review screen, the nav and the books list all read this one query.
 */
export async function reviewProgressForBooks(db: Db, bookIds: string[]): Promise<Map<string, ReviewProgress>> {
  if (bookIds.length === 0) return new Map();
  const found = await db.$queryRaw<ProgressRecord[]>`
    SELECT "bookId",
           coalesce(sum(cells), 0)::int AS cells,
           coalesce(sum(reviewed), 0)::int AS "reviewedCells",
           count(*)::int AS documents,
           count(*) FILTER (WHERE reviewed = cells)::int AS "reviewedDocuments"
    FROM (
      SELECT r."bookId", r."documentId", count(c.id) AS cells, count(c.id) FILTER (WHERE c."isReviewed") AS reviewed
      FROM "Row" r
      JOIN "Document" d ON d.id = r."documentId"
      JOIN "Template" t ON t.id = d."templateId"
      JOIN "Cell" c ON c."rowId" = r.id
      JOIN "OutputColumn" oc ON oc.id = c."outputColumnId"
      WHERE r."bookId" IN (${Prisma.join(bookIds)}) AND r."deletedAt" IS NULL AND NOT r."isVoid"
        AND ${COUNTING_DOC_TEMPLATE_SQL} AND oc."deletedAt" IS NULL
      GROUP BY r."bookId", r."documentId"
    ) per_document
    GROUP BY "bookId"`;
  return new Map(found.map(({ bookId, ...p }) => [bookId, p]));
}

/** One book's review progress. */
export async function reviewProgress(db: Db, bookId: string): Promise<ReviewProgress> {
  return (await reviewProgressForBooks(db, [bookId])).get(bookId) ?? NO_PROGRESS;
}

type QueueRecord = { id: string; documentId: string; position: string; cellIds: string[] };

/** Rows that still have unreviewed cells, in manual order, with those cells in column order. */
export async function reviewQueue(userId: string, bookId: string, input: ReviewQueueInput): Promise<ReviewQueuePage> {
  await requireBookAccess(userId, bookId);
  const after = input.cursor ? decodeCursor(input.cursor) : null;
  const cursorCond = after
    ? Prisma.sql`AND (r.position COLLATE "C" > ${after.position} COLLATE "C" OR (r.position = ${after.position} AND r.id > ${after.id}))`
    : Prisma.empty;
  const [found, progress] = await Promise.all([
    prisma.$queryRaw<QueueRecord[]>`
      SELECT r.id, r."documentId", r.position,
             array_agg(c.id ORDER BY oc.position COLLATE "C", oc.id) AS "cellIds"
      FROM "Row" r
      JOIN "Document" d ON d.id = r."documentId"
      JOIN "Template" t ON t.id = d."templateId"
      JOIN "Cell" c ON c."rowId" = r.id AND NOT c."isReviewed"
      JOIN "OutputColumn" oc ON oc.id = c."outputColumnId" AND oc."deletedAt" IS NULL
      WHERE r."bookId" = ${bookId} AND r."deletedAt" IS NULL AND NOT r."isVoid"
        AND ${COUNTING_DOC_TEMPLATE_SQL} ${cursorCond}
      GROUP BY r.id
      ORDER BY r.position COLLATE "C", r.id
      LIMIT ${input.limit + 1}`,
    reviewProgress(prisma, bookId),
  ]);
  const rows = found.slice(0, input.limit);
  const last = rows.at(-1);
  return {
    items: rows.map((r) => ({ rowId: r.id, documentId: r.documentId, unreviewedCellIds: r.cellIds })),
    nextCursor: found.length > input.limit && last ? encodeCursor(last.position, last.id) : null,
    progress,
  };
}

type ResumeRecord = { rowId: string; documentId: string; documentLabel: string | null };

/**
 * Where review stopped (docs/06 Phase 19). The unit of returning work is the document, and the document review stopped
 * in is the one holding the book's most recently reviewed cell: derived from `reviewedAt`, so it needs no storage and
 * follows the operator to another browser. Resumes at the first row with an unreviewed cell at or after that row, in
 * review order, wrapping to the top. Null when nothing is reviewed yet (the book isn't half-reviewed) or nothing is left.
 *
 * `stopped` sorts the book's reviewed cells by `reviewedAt` with no index behind it; see `reviewPace` for when that
 * stops being fine and which index answers both.
 */
export async function resumePoint(userId: string, bookId: string): Promise<ResumePoint | null> {
  await requireBookAccess(userId, bookId);
  const [found] = await prisma.$queryRaw<ResumeRecord[]>`
    WITH stopped AS (
      SELECT r.id, r.position
      FROM "Row" r
      JOIN "Document" d ON d.id = r."documentId"
      JOIN "Template" t ON t.id = d."templateId"
      JOIN "Cell" c ON c."rowId" = r.id AND c."isReviewed" AND c."reviewedAt" IS NOT NULL
      JOIN "OutputColumn" oc ON oc.id = c."outputColumnId" AND oc."deletedAt" IS NULL
      WHERE r."bookId" = ${bookId} AND r."deletedAt" IS NULL AND NOT r."isVoid" AND ${COUNTING_DOC_TEMPLATE_SQL}
      ORDER BY c."reviewedAt" DESC, r.position COLLATE "C" DESC, r.id DESC
      LIMIT 1
    ), open_rows AS (
      SELECT r.id, r."documentId", r.position, d.label
      FROM "Row" r
      JOIN "Document" d ON d.id = r."documentId"
      JOIN "Template" t ON t.id = d."templateId"
      WHERE r."bookId" = ${bookId} AND r."deletedAt" IS NULL AND NOT r."isVoid" AND ${COUNTING_DOC_TEMPLATE_SQL}
        AND EXISTS (
          SELECT 1 FROM "Cell" c JOIN "OutputColumn" oc ON oc.id = c."outputColumnId" AND oc."deletedAt" IS NULL
          WHERE c."rowId" = r.id AND NOT c."isReviewed"
        )
    )
    SELECT o.id AS "rowId", o."documentId", o.label AS "documentLabel"
    FROM open_rows o CROSS JOIN stopped s
    -- Rows before the stopping point sort after the rest: at or after it first, then wrap to the top.
    ORDER BY (o.position COLLATE "C" < s.position COLLATE "C" OR (o.position COLLATE "C" = s.position COLLATE "C" AND o.id < s.id)),
             o.position COLLATE "C", o.id
    LIMIT 1`;
  return found ?? null;
}
