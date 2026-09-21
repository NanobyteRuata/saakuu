import { Prisma } from "@prisma/client";
import { generateKeyBetween } from "fractional-indexing";
import { z } from "zod";

import { requireBookAccess, requireUserId } from "@/lib/auth/guards";
import { loadColumns } from "@/lib/books/columns-service";
import { prisma } from "@/lib/db/client";
import { COUNTING_DOC_TEMPLATE_SQL, countingRowWhere } from "@/lib/db/scope";
import { lockBook, type Db } from "@/lib/documents/access";
import { AppError } from "@/lib/errors";
import { impactHash } from "@/lib/impact";
import { buildTree } from "@/lib/templates/tree";
import { firstWorkingMappings } from "@/lib/transform/run";
import { loadTemplateContext } from "@/lib/transform/service";
import { revalidate, type TouchedValue } from "@/lib/validation/revalidate";

import {
  coalesce,
  editFlagsSchema,
  planEdit,
  planKeepMine,
  planRevert,
  planUndo,
  type CellSnapshot,
  type ChangePlan,
} from "./edits";
import type { EditCellInput, ListRowsInput, ReorderRowInput, ReviewCellsInput, RowsActionInput } from "./schemas";
import type { CellChangeResult, CellValidationUpdate, ColumnSource, TableCell, TableDocument, TableMeta, TableRow } from "./types";
import { decodeCursor, encodeCursor } from "./cursor";
import { encodeRow, type WirePage } from "./wire";

/**
 * The output table (docs/05 §12): rows in manual order, cell edits with a CellEdit log and undo, revert,
 * row order, void, delete and review marks. Every change re-checks validation in the same transaction, so
 * the cell a person just typed into shows its flags at once.
 */

const MAX_TEMPLATES = 200;
const CELL_CHANGE_TIMEOUT = 30_000;

// ---------- access ----------

export const liveRow = (userId: string) =>
  ({ deletedAt: null, document: { deletedAt: null, template: { deletedAt: null } }, book: { userId, deletedAt: null } }) satisfies Prisma.RowWhereInput;

async function requireCellAccess(userId: string, cellId: string): Promise<{ id: string; rowId: string; bookId: string; outputColumnId: string }> {
  const uid = requireUserId(userId);
  const cell = await prisma.cell.findFirst({
    where: { id: cellId, column: { deletedAt: null }, row: liveRow(uid) },
    select: { id: true, rowId: true, outputColumnId: true, row: { select: { bookId: true } } },
  });
  if (!cell) throw new AppError("NOT_FOUND", "That cell doesn't exist any more. Refresh the table.");
  return { id: cell.id, rowId: cell.rowId, bookId: cell.row.bookId, outputColumnId: cell.outputColumnId };
}

async function requireRowsAccess(userId: string, ids: string[]): Promise<{ bookId: string; ids: string[] }> {
  const uid = requireUserId(userId);
  const unique = [...new Set(ids)].sort();
  const rows = await prisma.row.findMany({ where: { id: { in: unique }, ...liveRow(uid) }, select: { id: true, bookId: true }, take: unique.length });
  const bookId = rows[0]?.bookId;
  if (rows.length !== unique.length || !bookId) throw new AppError("NOT_FOUND", "One or more of these rows doesn't exist any more. Refresh the table.");
  if (rows.some((r) => r.bookId !== bookId)) throw new AppError("VALIDATION", "These rows are in different books.");
  return { bookId, ids: unique };
}

// ---------- reads ----------

const cellSelect = {
  id: true,
  rowId: true,
  outputColumnId: true,
  currentValue: true,
  state: true,
  extractedValue: true,
  extractedState: true,
  isEdited: true,
  isReviewed: true,
  inherited: true,
  disagreement: true,
  confidence: true,
  validationState: true,
  validationMsgs: true,
} satisfies Prisma.CellSelect;

type CellRecord = Prisma.CellGetPayload<{ select: typeof cellSelect }>;

function toTableCell(c: CellRecord): TableCell {
  return {
    id: c.id,
    columnId: c.outputColumnId,
    value: c.currentValue,
    state: c.state,
    extractedValue: c.extractedValue,
    extractedState: c.extractedState,
    isEdited: c.isEdited,
    isReviewed: c.isReviewed,
    inherited: c.inherited,
    disagreement: c.disagreement,
    confidence: c.confidence,
    validationState: c.validationState,
    validationMsgs: c.validationMsgs,
  };
}

export const bboxSchema = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() });

type RowRecord = { id: string; documentId: string; position: string; isVoid: boolean; voidReason: string | null; photoId: string | null; bbox: unknown };

/** A page of live rows in manual order (code-unit order of `position`, then id), with their cells. */
export async function listRows(userId: string, bookId: string, input: ListRowsInput): Promise<WirePage> {
  await requireBookAccess(userId, bookId);
  const after = input.cursor ? decodeCursor(input.cursor) : null;
  const cursorCond = after
    ? Prisma.sql`AND (r.position COLLATE "C" > ${after.position} COLLATE "C" OR (r.position = ${after.position} AND r.id > ${after.id}))`
    : Prisma.empty;
  const found = await prisma.$queryRaw<RowRecord[]>`
    SELECT r.id, r."documentId", r.position, r."isVoid", r."voidReason", rr."photoId", rr.bbox
    FROM "Row" r
    JOIN "Document" d ON d.id = r."documentId"
    JOIN "Template" t ON t.id = d."templateId"
    LEFT JOIN "RawRecord" rr ON rr.id = r."rawRecordId"
    WHERE r."bookId" = ${bookId} AND r."deletedAt" IS NULL AND ${COUNTING_DOC_TEMPLATE_SQL} ${cursorCond}
    ORDER BY r.position COLLATE "C", r.id
    LIMIT ${input.limit + 1}`;
  const rows = found.slice(0, input.limit);
  const last = rows.at(-1);
  const nextCursor = found.length > input.limit && last ? encodeCursor(last.position, last.id) : null;

  const columns = await loadColumns(prisma, bookId);
  const columnIds = columns.map((c) => c.id);
  const rowIds = rows.map((r) => r.id);
  const [cells, documents] = await Promise.all([
    rowIds.length === 0
      ? Promise.resolve([])
      : prisma.cell.findMany({ where: { rowId: { in: rowIds }, outputColumnId: { in: columnIds } }, select: cellSelect, take: rowIds.length * Math.max(columnIds.length, 1) }),
    prisma.document.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.documentId))] } },
      select: { id: true, label: true, templateId: true, needsReview: true },
      take: rows.length,
    }),
  ]);
  const byRow = new Map<string, Record<string, TableCell>>();
  for (const c of cells) {
    const map = byRow.get(c.rowId) ?? {};
    map[c.outputColumnId] = toTableCell(c);
    byRow.set(c.rowId, map);
  }
  const items = rows.map((r): TableRow => {
    const bbox = bboxSchema.safeParse(r.bbox);
    return {
      id: r.id,
      documentId: r.documentId,
      position: r.position,
      isVoid: r.isVoid,
      voidReason: r.voidReason,
      photoId: r.photoId,
      bbox: bbox.success ? bbox.data : null,
      cells: byRow.get(r.id) ?? {},
    };
  });
  return { columnIds, items: items.map((r) => encodeRow(r, columnIds)), documents: documents satisfies TableDocument[], nextCursor };
}

/** Columns, templates, how each template fills columns (Manual / Skip sources) and the live row count. */
export async function getTableMeta(userId: string, bookId: string): Promise<TableMeta> {
  await requireBookAccess(userId, bookId);
  const [book, columns, templates, totalRows] = await Promise.all([
    prisma.book.findUniqueOrThrow({ where: { id: bookId }, select: { numeralSystem: true, dateEra: true } }),
    loadColumns(prisma, bookId),
    prisma.template.findMany({ where: { bookId, deletedAt: null }, select: { id: true, name: true, position: true }, take: MAX_TEMPLATES }),
    prisma.row.count({ where: { bookId, ...countingRowWhere } }),
  ]);
  // Decided exactly as the transform decides which mapping fills a column.
  const columnSources: TableMeta["columnSources"] = {};
  const filled = new Set<string>();
  for (const t of templates) {
    const ctx = await loadTemplateContext(prisma, t.id);
    if (!ctx) continue;
    const fields = new Map(ctx.fields.map((f) => [f.id, f]));
    const working = firstWorkingMappings(ctx.mappings, { tree: buildTree(ctx.groups, ctx.fields), liveColumnIds: new Set(ctx.columns.map((c) => c.id)) });
    for (const [columnId, mapping] of working) {
      filled.add(columnId);
      const modes = mapping.inputs.map((i) => (i.kind === "field" ? fields.get(i.fieldId)?.mode : undefined));
      const source: ColumnSource | null = modes.length === 0 ? null : modes.every((m) => m === "MANUAL") ? "MANUAL" : modes.every((m) => m === "SKIP") ? "SKIP" : null;
      if (source) (columnSources[t.id] ??= {})[columnId] = source;
    }
  }
  templates.sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : a.id < b.id ? -1 : 1));
  return {
    bookId,
    columns: columns.map((c) => ({ id: c.id, key: c.key, label: c.label, dataType: c.dataType, isRequired: c.isRequired })),
    templates: templates.map((t) => ({ id: t.id, name: t.name })),
    columnSources,
    unfilledColumnIds: columns.filter((c) => !filled.has(c.id)).map((c) => c.id),
    numeralSystem: book.numeralSystem,
    dateEra: book.dateEra,
    totalRows,
  };
}

// ---------- cell changes ----------

type LockedCell = CellSnapshot & { id: string; rowId: string; outputColumnId: string; bookId: string };

/** Locks cells for the rest of the transaction and reads what a change is planned from. */
async function lockCells(tx: Db, where: Prisma.Sql): Promise<LockedCell[]> {
  return tx.$queryRaw<LockedCell[]>`
    SELECT c.id, c."rowId", c."outputColumnId", r."bookId", c."currentValue", c.state, c."extractedValue", c."extractedState", c."isEdited", c.disagreement
    FROM "Cell" c JOIN "Row" r ON r.id = c."rowId"
    WHERE r."deletedAt" IS NULL AND ${where}
    ORDER BY c.id
    FOR UPDATE OF c`;
}

async function lockCell(tx: Db, cellId: string): Promise<LockedCell> {
  const [cell] = await lockCells(tx, Prisma.sql`c.id = ${cellId}`);
  if (!cell) throw new AppError("NOT_FOUND", "That cell doesn't exist any more. Refresh the table.");
  return cell;
}

async function writeCell(tx: Db, cell: LockedCell, plan: Extract<ChangePlan, { kind: "write" }>): Promise<void> {
  await tx.cell.update({
    where: { id: cell.id },
    data: { currentValue: plan.write.currentValue, state: plan.write.state, isEdited: plan.write.isEdited, disagreement: plan.write.disagreement },
  });
}

async function finish(tx: Db, cell: LockedCell, editId: string | null, touched: TouchedValue[]): Promise<CellChangeResult> {
  const changes = await revalidate(tx, cell.bookId, { rowIds: [cell.rowId] }, touched);
  const fresh = await tx.cell.findUniqueOrThrow({ where: { id: cell.id }, select: cellSelect });
  const affected: CellValidationUpdate[] = changes.filter((c) => c.id !== cell.id);
  return { cell: toTableCell(fresh), rowId: cell.rowId, editId, affected };
}

function touchedBy(cell: LockedCell, plan: ChangePlan): TouchedValue[] {
  if (plan.kind !== "write") return [];
  return [
    { columnId: cell.outputColumnId, value: cell.currentValue },
    { columnId: cell.outputColumnId, value: plan.write.currentValue },
  ];
}

async function bookSettings(tx: Db, bookId: string) {
  return tx.book.findUniqueOrThrow({ where: { id: bookId }, select: { numeralSystem: true, dateEra: true } });
}

/**
 * Saves a typed value. Debounced saves of one editing session pass the `editId` the first save returned; while
 * that entry is still the cell's latest change, it is extended rather than a new one written, so undo takes the
 * whole session back.
 */
export async function editCell(userId: string, cellId: string, input: EditCellInput): Promise<CellChangeResult> {
  const access = await requireCellAccess(userId, cellId);
  return prisma.$transaction(
    async (tx) => {
      const cell = await lockCell(tx, access.id);
      const column = (await loadColumns(tx, cell.bookId)).find((c) => c.id === cell.outputColumnId);
      if (!column) throw new AppError("NOT_FOUND", "That column was deleted. Refresh the table.");
      const plan = planEdit(cell, input, column, await bookSettings(tx, cell.bookId));
      if (plan.kind === "noop") return finish(tx, cell, input.editId ?? null, []);
      await writeCell(tx, cell, plan);

      let editId: string | null = null;
      if (input.editId) {
        const session = await tx.cellEdit.findFirst({
          where: { id: input.editId, cellId: cell.id, userId, kind: "EDIT" },
          select: { id: true, previousValue: true, newValue: true, flags: true },
        });
        const latest = await tx.cellEdit.findFirst({ where: { cellId: cell.id }, orderBy: { createdAt: "desc" }, select: { id: true } });
        const flags = session ? editFlagsSchema.safeParse(session.flags) : null;
        if (session && latest?.id === session.id && flags?.success && session.newValue === cell.currentValue && flags.data.after.state === cell.state) {
          const merged = coalesce({ previousValue: session.previousValue, newValue: session.newValue, flags: flags.data }, plan);
          await tx.cellEdit.update({ where: { id: session.id }, data: { newValue: merged.newValue, flags: merged.flags } });
          editId = session.id;
        }
      }
      if (editId === null) {
        const created = await tx.cellEdit.create({
          data: { cellId: cell.id, userId, kind: "EDIT", previousValue: plan.previousValue, newValue: plan.write.currentValue, flags: plan.flags },
          select: { id: true },
        });
        editId = created.id;
      }
      return finish(tx, cell, editId, touchedBy(cell, plan));
    },
    { timeout: CELL_CHANGE_TIMEOUT },
  );
}

export async function revertCell(userId: string, cellId: string): Promise<CellChangeResult> {
  const access = await requireCellAccess(userId, cellId);
  return prisma.$transaction(
    async (tx) => {
      const cell = await lockCell(tx, access.id);
      const plan = planRevert(cell);
      if (plan.kind === "noop") return finish(tx, cell, null, []);
      await writeCell(tx, cell, plan);
      const log = await tx.cellEdit.create({
        data: { cellId: cell.id, userId, kind: "REVERT", previousValue: plan.previousValue, newValue: plan.write.currentValue, flags: plan.flags },
        select: { id: true },
      });
      return finish(tx, cell, log.id, touchedBy(cell, plan));
    },
    { timeout: CELL_CHANGE_TIMEOUT },
  );
}

/** Keeps the person's value and settles a disagreement with a newer reading. */
export async function keepMine(userId: string, cellId: string): Promise<CellChangeResult> {
  const access = await requireCellAccess(userId, cellId);
  return prisma.$transaction(async (tx) => {
    const cell = await lockCell(tx, access.id);
    const plan = planKeepMine(cell);
    if (plan.kind === "write") await writeCell(tx, cell, plan);
    return finish(tx, cell, null, []);
  });
}

/** Undoes a logged change (an edit session, a revert or an undo) while the cell still holds what it wrote. */
export async function undoEdit(userId: string, editId: string): Promise<CellChangeResult> {
  const uid = requireUserId(userId);
  const edit = await prisma.cellEdit.findFirst({
    where: { id: editId, userId: uid, cell: { column: { deletedAt: null }, row: liveRow(uid) } },
    select: { id: true, cellId: true, previousValue: true, newValue: true, flags: true },
  });
  if (!edit) throw new AppError("NOT_FOUND", "There's nothing to undo for that cell any more.");
  const flags = editFlagsSchema.safeParse(edit.flags);
  if (!flags.success) throw new AppError("CONFLICT", "That change can't be undone. Edit the cell instead.");
  return prisma.$transaction(
    async (tx) => {
      const cell = await lockCell(tx, edit.cellId);
      const plan = planUndo(cell, { previousValue: edit.previousValue, newValue: edit.newValue, flags: flags.data });
      if (plan.kind === "refused") throw new AppError("CONFLICT", plan.reason);
      if (plan.kind === "noop") return finish(tx, cell, null, []);
      await writeCell(tx, cell, plan);
      const log = await tx.cellEdit.create({
        data: { cellId: cell.id, userId: uid, kind: "UNDO", previousValue: plan.previousValue, newValue: plan.write.currentValue, flags: plan.flags },
        select: { id: true },
      });
      return finish(tx, cell, log.id, touchedBy(cell, plan));
    },
    { timeout: CELL_CHANGE_TIMEOUT },
  );
}

export async function setCellsReviewed(userId: string, input: ReviewCellsInput): Promise<{ cells: number }> {
  const uid = requireUserId(userId);
  const or: Prisma.CellWhereInput[] = [];
  if (input.cellIds?.length) or.push({ id: { in: input.cellIds } });
  if (input.rowIds?.length) or.push({ rowId: { in: input.rowIds } });
  const where = { OR: or, column: { deletedAt: null }, row: liveRow(uid) } satisfies Prisma.CellWhereInput;
  // Phase 12: when and how (decision 57). The `isReviewed: !input.isReviewed` filter is also what
  // keeps a row-level mark from restamping a cell the operator had already confirmed on its own —
  // which is exactly the distinction that makes recording the source worth anything.
  const data = input.isReviewed
    ? { isReviewed: true, reviewedAt: new Date(), reviewedVia: input.via }
    : { isReviewed: false, reviewedAt: null, reviewedVia: null };
  const { count } = await prisma.cell.updateMany({ where: { ...where, isReviewed: !input.isReviewed }, data });
  return { cells: count };
}

// ---------- rows ----------

/**
 * Moves one row after another in manual order (null = first). Writes exactly one row: its new position lies
 * between the row it follows and whatever comes next (docs/02 invariant 6). Rows are compared code-unit.
 */
export async function reorderRow(userId: string, input: ReorderRowInput): Promise<{ position: string; affected: CellValidationUpdate[] }> {
  const ids = input.afterRowId ? [input.rowId, input.afterRowId] : [input.rowId];
  if (input.afterRowId === input.rowId) throw new AppError("VALIDATION", "A row can't be moved after itself.");
  const { bookId } = await requireRowsAccess(userId, ids);
  return prisma.$transaction(async (tx) => {
    await lockBook(tx, bookId);
    let lo: string | null = null;
    if (input.afterRowId) {
      const after = await tx.row.findUniqueOrThrow({ where: { id: input.afterRowId }, select: { position: true } });
      lo = after.position;
    }
    const next = lo === null
      ? await tx.$queryRaw<{ position: string }[]>`
          SELECT position FROM "Row" WHERE "bookId" = ${bookId} AND id <> ${input.rowId}
          ORDER BY position COLLATE "C" LIMIT 1`
      : await tx.$queryRaw<{ position: string }[]>`
          SELECT position FROM "Row" WHERE "bookId" = ${bookId} AND id <> ${input.rowId} AND position COLLATE "C" > ${lo} COLLATE "C"
          ORDER BY position COLLATE "C" LIMIT 1`;
    const hi = next[0]?.position ?? null;
    let position: string;
    try {
      position = generateKeyBetween(lo, hi);
    } catch {
      throw new AppError("CONFLICT", "Rows here share a position, so this move can't be placed. Refresh the table and try again.");
    }
    await tx.row.update({ where: { id: input.rowId }, data: { position } });
    // An increasing-order rule reads the row above, so the row's document is checked again (cells only).
    const affected = await revalidate(tx, bookId, { rowIds: [input.rowId] });
    return { position, affected };
  });
}

async function uniqueTouched(tx: Db, rowIds: string[]): Promise<TouchedValue[]> {
  const cells = await tx.cell.findMany({ where: { rowId: { in: rowIds }, currentValue: { not: null } }, select: { outputColumnId: true, currentValue: true }, take: rowIds.length * 200 });
  return cells.map((c) => ({ columnId: c.outputColumnId, value: c.currentValue }));
}

/** Marks a row void or not by hand. A hand-set state is kept by rebuilds (docs/02 → Mapping and transform). */
export async function setRowVoid(userId: string, rowId: string, isVoid: boolean): Promise<{ isVoid: boolean; affected: CellValidationUpdate[] }> {
  const { bookId } = await requireRowsAccess(userId, [rowId]);
  return prisma.$transaction(async (tx) => {
    await tx.row.update({ where: { id: rowId }, data: { isVoid } });
    const affected = await revalidate(tx, bookId, { rowIds: [rowId] }, await uniqueTouched(tx, [rowId]));
    return { isVoid, affected };
  });
}

export type RowsRevertImpact = { impactHash: string; rows: number; editedCells: number; disagreements: number };

async function computeRevertImpact(db: Db, ids: string[]): Promise<RowsRevertImpact> {
  const cells = { rowId: { in: ids } } satisfies Prisma.CellWhereInput;
  const [editedCells, disagreements, rows] = await Promise.all([
    db.cell.count({ where: { ...cells, isEdited: true } }),
    db.cell.count({ where: { ...cells, isEdited: false, disagreement: true } }),
    db.row.count({ where: { id: { in: ids }, cells: { some: { OR: [{ isEdited: true }, { disagreement: true }] } } } }),
  ]);
  const body = { rows, editedCells, disagreements };
  return { impactHash: impactHash({ action: "rows.revert", ids, ...body }), ...body };
}

export async function rowsRevertImpact(userId: string, ids: string[]): Promise<RowsRevertImpact> {
  const access = await requireRowsAccess(userId, ids);
  return computeRevertImpact(prisma, access.ids);
}

/** Reverts every edited cell of the rows to its extracted value, logging each as a revert (undoable per cell). */
/** Reverts every edited cell of the rows to its extracted value, logging each as a revert. `editIds` undo them one cell at a time. */
export async function revertRows(userId: string, input: RowsActionInput): Promise<{ cells: TableCell[]; affected: CellValidationUpdate[]; edits: { editId: string; rowId: string }[] }> {
  const access = await requireRowsAccess(userId, input.ids);
  return prisma.$transaction(
    async (tx) => {
      await lockBook(tx, access.bookId);
      const impact = await computeRevertImpact(tx, access.ids);
      if (impact.impactHash !== input.impactHash) throw new AppError("CONFLICT", "These rows changed since you reviewed the revert. Review it again.");
      const locked = await lockCells(tx, Prisma.sql`c."rowId" IN (${Prisma.join(access.ids)}) AND (c."isEdited" OR c.disagreement)`);
      const touched: TouchedValue[] = [];
      const edits: { editId: string; rowId: string }[] = [];
      for (const cell of locked) {
        const plan = planRevert(cell);
        if (plan.kind !== "write") continue;
        await writeCell(tx, cell, plan);
        const log = await tx.cellEdit.create({
          data: { cellId: cell.id, userId, kind: "REVERT", previousValue: plan.previousValue, newValue: plan.write.currentValue, flags: plan.flags },
          select: { id: true },
        });
        touched.push(...touchedBy(cell, plan));
        edits.push({ editId: log.id, rowId: cell.rowId });
      }
      const affected = await revalidate(tx, access.bookId, { rowIds: access.ids }, touched);
      const cells = await tx.cell.findMany({ where: { rowId: { in: access.ids } }, select: cellSelect, take: access.ids.length * 200 });
      return { cells: cells.map(toTableCell), affected, edits };
    },
    { timeout: 60_000 },
  );
}

export type RowsDeleteImpact = { impactHash: string; rows: number; cells: number; editedCells: number; reviewedCells: number };

async function computeDeleteImpact(db: Db, ids: string[]): Promise<RowsDeleteImpact> {
  const cells = { rowId: { in: ids }, NOT: [{ currentValue: null }, { currentValue: "" }] } satisfies Prisma.CellWhereInput;
  const [filled, editedCells, reviewedCells] = await Promise.all([
    db.cell.count({ where: cells }),
    db.cell.count({ where: { rowId: { in: ids }, isEdited: true } }),
    db.cell.count({ where: { rowId: { in: ids }, isReviewed: true } }),
  ]);
  const body = { rows: ids.length, cells: filled, editedCells, reviewedCells };
  return { impactHash: impactHash({ action: "rows.delete", ids, ...body }), ...body };
}

export async function rowsDeleteImpact(userId: string, ids: string[]): Promise<RowsDeleteImpact> {
  const access = await requireRowsAccess(userId, ids);
  return computeDeleteImpact(prisma, access.ids);
}

/**
 * Deletes rows from the table. Soft: a rebuild still matches a deleted row by its record key and keeps it
 * deleted, so a row removed by hand doesn't come back with the next re-extraction.
 */
export async function deleteRows(userId: string, input: RowsActionInput): Promise<{ deleted: number; affected: CellValidationUpdate[] }> {
  const access = await requireRowsAccess(userId, input.ids);
  return prisma.$transaction(
    async (tx) => {
      await lockBook(tx, access.bookId);
      const impact = await computeDeleteImpact(tx, access.ids);
      if (impact.impactHash !== input.impactHash) throw new AppError("CONFLICT", "These rows changed since you reviewed the delete. Review it again.");
      const touched = await uniqueTouched(tx, access.ids);
      const { count } = await tx.row.updateMany({ where: { id: { in: access.ids }, deletedAt: null }, data: { deletedAt: new Date() } });
      const affected = await revalidate(tx, access.bookId, { rowIds: access.ids }, touched);
      return { deleted: count, affected: affected.filter((a) => !access.ids.includes(a.rowId)) };
    },
    { timeout: 60_000 },
  );
}
