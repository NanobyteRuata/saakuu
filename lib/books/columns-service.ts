import type { Prisma } from "@prisma/client";

import { requireBookAccess } from "@/lib/auth/guards";
import { prisma } from "@/lib/db/client";
import { AppError } from "@/lib/errors";
import { impactHash, type BrokenMapping, type ImpactReport } from "@/lib/impact";

import {
  classifyColumnChange,
  deletedColumnKey,
  simulateColumnOps,
  sortByPosition,
  type ColumnSimulation,
  type ColumnState,
} from "./column-ops";
import { MAX_COLUMNS, type ApplyColumnOpsInput, type ColumnOp } from "./schemas";

type Db = Prisma.TransactionClient;

const CELL_CHUNK = 1000;
const MAPPING_LIMIT = 1000;

const columnSelect = {
  id: true,
  key: true,
  label: true,
  dataType: true,
  enumValues: true,
  isRequired: true,
  position: true,
} satisfies Prisma.OutputColumnSelect;

/** Live columns in manual order. Sorted in JS: fractional keys need code-unit order, not DB collation. */
export async function loadColumns(db: Db, bookId: string): Promise<ColumnState[]> {
  const columns = await db.outputColumn.findMany({
    where: { bookId, deletedAt: null },
    select: columnSelect,
    take: MAX_COLUMNS,
  });
  return sortByPosition(columns);
}

export async function listColumns(userId: string, bookId: string): Promise<ColumnState[]> {
  await requireBookAccess(userId, bookId);
  return loadColumns(prisma, bookId);
}

async function computeImpact(
  db: Db,
  bookId: string,
  ops: ColumnOp[],
): Promise<{ report: ImpactReport; sim: ColumnSimulation }> {
  const current = await loadColumns(db, bookId);
  const sim = simulateColumnOps(current, ops);
  const { severity, deletedIds, retypedIds } = classifyColumnChange(current, sim);
  const labels = new Map(current.map((c) => [c.id, c.label]));

  let brokenMappings: BrokenMapping[] = [];
  let affectedRows = 0;
  let affectedCells = 0;
  let editedCells = 0;
  let reviewedCells = 0;

  if (deletedIds.length > 0) {
    const mappings = await db.mapping.findMany({
      where: { outputColumnId: { in: deletedIds }, template: { deletedAt: null } },
      select: { templateId: true, outputColumnId: true, template: { select: { name: true } } },
      orderBy: [{ templateId: "asc" }, { id: "asc" }],
      take: MAPPING_LIMIT,
    });
    brokenMappings = mappings.map((m) => ({
      templateId: m.templateId,
      templateName: m.template.name,
      columnLabel: labels.get(m.outputColumnId) ?? "",
      reason: "Its output column is being deleted.",
    }));
  }

  const touched = [...deletedIds, ...retypedIds];
  if (touched.length > 0) {
    // A cell is affected if it holds a value or a human touched it (an edit may have cleared it).
    const affected = {
      outputColumnId: { in: touched },
      OR: [{ NOT: [{ currentValue: null }, { currentValue: "" }] }, { isEdited: true }],
    } satisfies Prisma.CellWhereInput;
    const onLiveDocument = { row: { document: { deletedAt: null } } } satisfies Prisma.CellWhereInput;
    [affectedCells, editedCells, reviewedCells, affectedRows] = await Promise.all([
      db.cell.count({ where: { ...affected, ...onLiveDocument } }),
      db.cell.count({ where: { ...affected, ...onLiveDocument, isEdited: true } }),
      db.cell.count({ where: { ...affected, ...onLiveDocument, isReviewed: true } }),
      db.row.count({ where: { bookId, document: { deletedAt: null }, cells: { some: affected } } }),
    ]);
  }

  const body = {
    severity,
    brokenMappings,
    clearedColumns: deletedIds,
    affectedRows,
    affectedCells,
    editedCells,
    reviewedCells,
  };
  const hash = impactHash({ action: "columns.apply", bookId, ops, columns: current, ...body });
  return { report: { impactHash: hash, ...body }, sim };
}

export async function previewColumnOps(userId: string, bookId: string, ops: ColumnOp[]): Promise<ImpactReport> {
  await requireBookAccess(userId, bookId);
  return (await computeImpact(prisma, bookId, ops)).report;
}

/** Gives every existing row of the book an empty cell in a new column (one Cell per row × column). */
async function createEmptyCells(db: Db, bookId: string, outputColumnId: string): Promise<void> {
  let cursor: string | undefined;
  for (;;) {
    const rows = await db.row.findMany({
      where: { bookId },
      select: { id: true },
      orderBy: { id: "asc" },
      take: CELL_CHUNK,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (rows.length === 0) return;
    await db.cell.createMany({
      data: rows.map((r) => ({ rowId: r.id, outputColumnId, state: "EMPTY" as const })),
      skipDuplicates: true,
    });
    if (rows.length < CELL_CHUNK) return;
    cursor = rows.at(-1)?.id;
  }
}

export async function applyColumnOps(
  userId: string,
  bookId: string,
  input: ApplyColumnOpsInput,
): Promise<{ columns: ColumnState[]; report: ImpactReport }> {
  await requireBookAccess(userId, bookId);

  return prisma.$transaction(
    async (tx) => {
      // Serialise column changes per book so the recomputed impact is the one being applied.
      await tx.$queryRaw`SELECT id FROM "Book" WHERE id = ${bookId} AND "deletedAt" IS NULL FOR UPDATE`;

      const { report, sim } = await computeImpact(tx, bookId, input.ops);
      if (report.impactHash !== input.impactHash) {
        throw new AppError(
          "CONFLICT",
          "The output table changed since you reviewed this change. Review the impact again before saving.",
        );
      }

      const now = new Date();

      // 1. Deletes first: parking their keys frees them for reuse below.
      if (sim.deletes.length > 0) {
        for (const col of sim.deletes) {
          await tx.outputColumn.update({
            where: { id: col.id },
            data: { deletedAt: now, key: deletedColumnKey(col.key, col.id) },
          });
        }
        const deletedIds = sim.deletes.map((c) => c.id);
        const templates = await tx.mapping.findMany({
          where: { outputColumnId: { in: deletedIds } },
          select: { templateId: true },
          distinct: ["templateId"],
          take: MAPPING_LIMIT,
        });
        await tx.mapping.updateMany({ where: { outputColumnId: { in: deletedIds } }, data: { state: "BROKEN" } });
        if (templates.length > 0) {
          await tx.template.updateMany({
            where: { id: { in: templates.map((t) => t.templateId) } },
            data: { configState: "CONFLICTED" },
          });
        }
      }

      // 2. Park changing keys so swaps (a→b, b→a) never trip the unique index mid-way.
      for (const { id, data } of sim.updates) {
        if (data.key !== undefined) {
          await tx.outputColumn.update({ where: { id }, data: { key: `~moving~${id}` } });
        }
      }
      for (const { id, data } of sim.updates) {
        await tx.outputColumn.update({ where: { id }, data });
      }

      // 3. Creates, each with an empty cell for every existing row.
      for (const { key, label, dataType, enumValues, isRequired, position } of sim.creates) {
        const created = await tx.outputColumn.create({
          data: { bookId, key, label, dataType, enumValues, isRequired, position },
          select: { id: true },
        });
        await createEmptyCells(tx, bookId, created.id);
      }

      // 4. Moves: one row each.
      for (const { id, position } of sim.positionWrites) {
        await tx.outputColumn.update({ where: { id }, data: { position } });
      }

      await tx.book.update({ where: { id: bookId }, data: { updatedAt: now } });

      return { columns: await loadColumns(tx, bookId), report };
    },
    { timeout: 30_000 },
  );
}
