import { Prisma } from "@prisma/client";

import { requireBookAccess, requireUserId } from "@/lib/auth/guards";
import { loadColumns } from "@/lib/books/columns-service";
import { prisma } from "@/lib/db/client";
import { AppError } from "@/lib/errors";
import { log } from "@/lib/log";

import { BOM, csvLine, exportFileName, exportValue, type ExportTokens } from "./csv";
import type { ExportOptions } from "./schemas";
import { issueExportLink, readExportLink } from "./token";

/**
 * CSV export (docs/01 §6.11, docs/04 → Export). Rows in manual order, streamed page by page so a large book is
 * never held in memory. Exports the same rows the table shows: live rows of live documents and templates.
 */

const PAGE_SIZE = 500;
const PROVENANCE = ["_document", "_template", "_photo", "_model", "_reviewed", "_confidence"] as const;

export type ExportPreview = {
  rows: number;
  columns: number;
  /** Over the exported columns of rows that aren't void, as the table counts them. */
  cells: number;
  unreviewedCells: number;
  errorCells: number;
  warningCells: number;
};

async function exportColumns(bookId: string, options: ExportOptions) {
  const all = await loadColumns(prisma, bookId);
  if (!options.columns) return { all, chosen: all };
  const wanted = new Set(options.columns);
  const chosen = all.filter((c) => wanted.has(c.id));
  if (chosen.length !== wanted.size) throw new AppError("VALIDATION", "One or more of the chosen columns was deleted. Reopen the export and choose again.");
  return { all, chosen };
}

const liveRows = (bookId: string) => Prisma.sql`r."bookId" = ${bookId} AND r."deletedAt" IS NULL AND d."deletedAt" IS NULL AND t."deletedAt" IS NULL`;

export async function exportPreview(userId: string, bookId: string, options: ExportOptions): Promise<ExportPreview> {
  await requireBookAccess(userId, bookId);
  const { chosen } = await exportColumns(bookId, options);
  const columnIds = chosen.map((c) => c.id);
  const voidCond = options.includeVoid ? Prisma.empty : Prisma.sql`AND NOT r."isVoid"`;
  const [[rows], [cells]] = await Promise.all([
    prisma.$queryRaw<{ rows: number }[]>`
      SELECT count(*)::int AS rows FROM "Row" r JOIN "Document" d ON d.id = r."documentId" JOIN "Template" t ON t.id = d."templateId"
      WHERE ${liveRows(bookId)} ${voidCond}`,
    columnIds.length === 0
      ? Promise.resolve([{ cells: 0, unreviewed: 0, errors: 0, warnings: 0 }])
      : prisma.$queryRaw<{ cells: number; unreviewed: number; errors: number; warnings: number }[]>`
          SELECT count(c.id)::int AS cells,
                 count(c.id) FILTER (WHERE NOT c."isReviewed")::int AS unreviewed,
                 count(c.id) FILTER (WHERE c."validationState" = 'ERROR')::int AS errors,
                 count(c.id) FILTER (WHERE c."validationState" = 'WARNING')::int AS warnings
          FROM "Row" r JOIN "Document" d ON d.id = r."documentId" JOIN "Template" t ON t.id = d."templateId"
          JOIN "Cell" c ON c."rowId" = r.id AND c."outputColumnId" IN (${Prisma.join(columnIds)})
          WHERE ${liveRows(bookId)} AND NOT r."isVoid"`,
  ]);
  return {
    rows: rows?.rows ?? 0,
    columns: chosen.length,
    cells: cells?.cells ?? 0,
    unreviewedCells: cells?.unreviewed ?? 0,
    errorCells: cells?.errors ?? 0,
    warningCells: cells?.warnings ?? 0,
  };
}

/**
 * Checks the options and returns a short-lived download link for them.
 *
 * The chosen tokens are saved back to the book, so the next export of it starts where this one
 * finished. Since Phase 14 the export dialog is the only place they are set: having them here *and*
 * in Settings was two places to set one thing, and Settings is the one you forget you touched.
 * Written here rather than from the browser so the preference survives a tab that goes away.
 */
export async function createExport(userId: string, bookId: string, options: ExportOptions): Promise<{ downloadUrl: string }> {
  const uid = requireUserId(userId);
  await requireBookAccess(uid, bookId);
  await exportColumns(bookId, options);
  // Only when they actually differ: `Book.updatedAt` is what the books list sorts on, so writing on
  // every export would reorder that list each time someone downloads a CSV.
  const stored = await prisma.book.findUniqueOrThrow({ where: { id: bookId }, select: { blankToken: true, illegibleToken: true } });
  const prefs: Prisma.BookUpdateInput = {};
  if (options.blankToken !== undefined && options.blankToken !== stored.blankToken) prefs.blankToken = options.blankToken;
  if (options.illegibleToken !== undefined && options.illegibleToken !== stored.illegibleToken) prefs.illegibleToken = options.illegibleToken;
  if (Object.keys(prefs).length > 0) await prisma.book.update({ where: { id: bookId }, data: prefs });
  return { downloadUrl: `/api/exports/${issueExportLink(bookId, uid, options)}` };
}

type ExportRow = { id: string; position: string; isVoid: boolean; label: string | null; lastModel: string | null; templateName: string; pageIndex: number | null };

/** The CSV for a download link, as a stream: BOM, header, then rows in manual order. */
export async function openExport(userId: string, link: string): Promise<{ fileName: string; stream: ReadableStream<Uint8Array> }> {
  const uid = requireUserId(userId);
  const { bookId, userId: linkUser, options } = readExportLink(link);
  if (linkUser !== uid) throw new AppError("NOT_FOUND", "This download link belongs to another account. Export again from the book.");
  await requireBookAccess(uid, bookId);
  const book = await prisma.book.findUniqueOrThrow({ where: { id: bookId }, select: { name: true, blankToken: true, illegibleToken: true } });
  const { all, chosen } = await exportColumns(bookId, options);
  const tokens: ExportTokens = { blankToken: options.blankToken ?? book.blankToken, illegibleToken: options.illegibleToken ?? book.illegibleToken };
  const allIds = all.map((c) => c.id);
  const voidCond = options.includeVoid ? Prisma.empty : Prisma.sql`AND NOT r."isVoid"`;

  const header = [...chosen.map((c) => c.key), ...(options.includeProvenance ? PROVENANCE : []), ...(options.includeVoid ? ["_void"] : [])];
  const encoder = new TextEncoder();
  let after: { position: string; id: string } | null = null;
  let started = false;
  let done = false;

  const pullPage = async (controller: ReadableStreamDefaultController<Uint8Array>) => {
      if (!started) {
        started = true;
        controller.enqueue(encoder.encode(BOM + csvLine(header)));
        return;
      }
      if (done) {
        controller.close();
        return;
      }
      const cursorCond: Prisma.Sql = after
        ? Prisma.sql`AND (r.position COLLATE "C" > ${after.position} COLLATE "C" OR (r.position = ${after.position} AND r.id > ${after.id}))`
        : Prisma.empty;
      const rows = await prisma.$queryRaw<ExportRow[]>`
        SELECT r.id, r.position, r."isVoid", d.label, d."lastModel", t.name AS "templateName", p."pageIndex"
        FROM "Row" r
        JOIN "Document" d ON d.id = r."documentId"
        JOIN "Template" t ON t.id = d."templateId"
        LEFT JOIN "RawRecord" rr ON rr.id = r."rawRecordId"
        LEFT JOIN "Photo" p ON p.id = rr."photoId"
        WHERE ${liveRows(bookId)} ${voidCond} ${cursorCond}
        ORDER BY r.position COLLATE "C", r.id
        LIMIT ${PAGE_SIZE}`;
      const last = rows.at(-1);
      if (!last) {
        controller.close();
        return;
      }
      after = { position: last.position, id: last.id };
      if (rows.length < PAGE_SIZE) done = true;
      const cells = allIds.length === 0
        ? []
        : await prisma.cell.findMany({
            where: { rowId: { in: rows.map((r) => r.id) }, outputColumnId: { in: allIds } },
            select: { rowId: true, outputColumnId: true, currentValue: true, state: true, isReviewed: true, confidence: true },
            take: rows.length * allIds.length,
          });
      const byRow = new Map<string, Map<string, (typeof cells)[number]>>();
      for (const c of cells) {
        const m = byRow.get(c.rowId) ?? new Map<string, (typeof cells)[number]>();
        m.set(c.outputColumnId, c);
        byRow.set(c.rowId, m);
      }
      let chunk = "";
      for (const r of rows) {
        const rowCells = byRow.get(r.id) ?? new Map<string, (typeof cells)[number]>();
        const fields = chosen.map((col) => {
          const c = rowCells.get(col.id);
          return exportValue(c ? { value: c.currentValue, state: c.state } : undefined, tokens);
        });
        if (options.includeProvenance) {
          const own = [...rowCells.values()];
          const confidences = own.flatMap((c) => (c.confidence === null ? [] : [c.confidence]));
          fields.push(
            r.label ?? "",
            r.templateName,
            r.pageIndex === null ? "" : String(r.pageIndex + 1),
            r.lastModel ?? "",
            own.length > 0 && own.every((c) => c.isReviewed) ? "yes" : "no",
            confidences.length > 0 ? Math.min(...confidences).toFixed(2) : "",
          );
        }
        if (options.includeVoid) fields.push(r.isVoid ? "yes" : "no");
        chunk += csvLine(fields);
      }
      controller.enqueue(encoder.encode(chunk));
  };

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        await pullPage(controller);
      } catch (err) {
        // Headers are already sent: abort the connection so the browser reports a failed download, not a short file.
        log.error("export stream failed", err, { bookId, after });
        controller.error(err);
      }
    },
  });
  return { fileName: exportFileName(book.name, new Date()), stream };
}
