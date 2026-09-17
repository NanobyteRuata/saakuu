import { Prisma } from "@prisma/client";

import { loadColumns } from "@/lib/books/columns-service";
import type { Db } from "@/lib/documents/access";
import type { ValidationState, ValueState } from "@/lib/transform/types";

import {
  MAX_RULES,
  parseIssues,
  toRuleInput,
  validateRows,
  type Duplicates,
  type RuleContext,
  type ValidationRow,
  type ValidationRuleInput,
} from "./rules";

/**
 * Works out and stores cells' validation state (lib/validation/rules.ts) after anything it depends on
 * changes: a rebuild, an edit, a revert, a row voided, deleted or moved, a rule saved. Only changed cells
 * are written, and each write is guarded on the value it was computed from, so a check that raced an edit
 * never stores a stale result.
 */

/** Documents validated per batch when a whole book or column is checked. */
const DOCUMENT_BATCH = 25;
const MAX_ROWS_PER_LOAD = 20_000;
const MAX_BOOK_DOCUMENTS = 20_000;
const WRITE_CHUNK = 500;

export type RevalidateScope = { rowIds?: string[]; documentIds?: string[]; columnIds?: string[]; all?: boolean };

/** A value a cell held or holds, in a column: rows elsewhere sharing it may gain or lose a UNIQUE flag. */
export type TouchedValue = { columnId: string; value: string | null };

export type ValidationChange = { id: string; rowId: string; validationState: ValidationState; validationMsgs: string[] };

export type ValidationContext = { ctx: RuleContext; rules: ValidationRuleInput[] };

export async function loadRules(db: Db, bookId: string): Promise<ValidationRuleInput[]> {
  const rows = await db.validationRule.findMany({
    where: { bookId },
    orderBy: { id: "asc" },
    take: MAX_RULES,
    select: { id: true, outputColumnId: true, kind: true, params: true, severity: true, message: true, enabled: true },
  });
  return rows.flatMap((r) => toRuleInput(r) ?? []);
}

/**
 * Values held by more than one counting row of the book, per column. `values` limits the count to the values the
 * rows being checked hold, so a single document's check doesn't group the whole book.
 */
export async function loadDuplicates(db: Db, bookId: string, columnIds: string[], values?: string[]): Promise<Duplicates> {
  const out = new Map<string, Map<string, number>>();
  if (columnIds.length === 0 || values?.length === 0) return out;
  const onlyValues = values ? Prisma.sql`AND c."currentValue" = ANY(${values})` : Prisma.empty;
  const rows = await db.$queryRaw<{ columnId: string; value: string; n: number }[]>`
    SELECT c."outputColumnId" AS "columnId", c."currentValue" AS value, count(*)::int AS n
    FROM "Cell" c JOIN "Row" r ON r.id = c."rowId" JOIN "Document" d ON d.id = r."documentId"
    WHERE r."bookId" = ${bookId} AND r."deletedAt" IS NULL AND NOT r."isVoid" AND d."deletedAt" IS NULL
      AND c."outputColumnId" IN (${Prisma.join(columnIds)}) AND c.state = 'OK'
      AND c."currentValue" IS NOT NULL AND c."currentValue" <> '' ${onlyValues}
    GROUP BY 1, 2 HAVING count(*) > 1`;
  for (const r of rows) {
    const byValue = out.get(r.columnId) ?? new Map<string, number>();
    byValue.set(r.value, r.n);
    out.set(r.columnId, byValue);
  }
  return out;
}

/** Book settings, columns and rules. Duplicates are loaded book-wide unless `withDuplicates` is false. */
export async function loadValidationContext(db: Db, bookId: string, rules?: ValidationRuleInput[], withDuplicates = true): Promise<ValidationContext> {
  const [book, columns, loaded] = await Promise.all([
    db.book.findUniqueOrThrow({ where: { id: bookId }, select: { numeralSystem: true, dateEra: true } }),
    loadColumns(db, bookId),
    rules ? Promise.resolve(rules) : loadRules(db, bookId),
  ]);
  const uniqueColumns = [...new Set(loaded.filter((r) => r.enabled && r.kind === "UNIQUE").map((r) => r.outputColumnId))];
  const duplicates = withDuplicates ? await loadDuplicates(db, bookId, uniqueColumns) : new Map<string, Map<string, number>>();
  return {
    rules: loaded,
    ctx: {
      book,
      duplicates,
      columns: new Map(columns.map((c) => [c.id, { id: c.id, key: c.key, label: c.label, dataType: c.dataType, enumValues: c.enumValues, isRequired: c.isRequired }])),
    },
  };
}

type StoredCell = { id: string; rowId: string; currentValue: string | null; isEdited: boolean; state: ValueState; validationState: ValidationState; validationMsgs: string[] };

async function loadRows(db: Db, bookId: string, where: Prisma.RowWhereInput, columnIds: string[] | null): Promise<{ rows: ValidationRow[]; stored: Map<string, StoredCell> }> {
  const found = await db.row.findMany({
    where: { bookId, document: { deletedAt: null }, ...where },
    take: MAX_ROWS_PER_LOAD,
    select: {
      id: true,
      documentId: true,
      position: true,
      isVoid: true,
      deletedAt: true,
      cells: {
        where: columnIds ? { outputColumnId: { in: columnIds } } : undefined,
        select: {
          id: true,
          outputColumnId: true,
          currentValue: true,
          state: true,
          isEdited: true,
          buildIssues: true,
          validationState: true,
          validationMsgs: true,
        },
      },
    },
  });
  const stored = new Map<string, StoredCell>();
  const rows = found.map((r): ValidationRow => {
    for (const c of r.cells) stored.set(c.id, { ...c, rowId: r.id });
    return {
      id: r.id,
      documentId: r.documentId,
      position: r.position,
      counts: !r.isVoid && r.deletedAt === null,
      cells: r.cells.map((c) => ({ ...c, buildIssues: parseIssues(c.buildIssues) })),
    };
  });
  return { rows, stored };
}

async function writeChanges(db: Db, changes: (ValidationChange & { stored: StoredCell })[]): Promise<void> {
  for (let i = 0; i < changes.length; i += WRITE_CHUNK) {
    const values = changes
      .slice(i, i + WRITE_CHUNK)
      .map(
        (c) =>
          Prisma.sql`(${c.id}, ${c.stored.currentValue}::text, ${c.stored.isEdited}::boolean, ${c.stored.state}::text, ${c.validationState}::text, ${c.validationMsgs}::text[])`,
      );
    // Guarded on the value the check was computed from: an edit saved meanwhile is checked by its own save.
    await db.$executeRaw`
      UPDATE "Cell" AS c SET "validationState" = v.vs::"ValidationState", "validationMsgs" = v.msgs
      FROM (VALUES ${Prisma.join(values)}) AS v(id, cv, ie, st, vs, msgs)
      WHERE c.id = v.id AND c."currentValue" IS NOT DISTINCT FROM v.cv AND c."isEdited" = v.ie AND c.state = v.st::"ValueState"`;
  }
}

function sameMsgs(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((m, i) => m === b[i]);
}

async function validateAndWrite(db: Db, context: ValidationContext, loaded: { rows: ValidationRow[]; stored: Map<string, StoredCell> }, onlyColumns: Set<string> | null): Promise<ValidationChange[]> {
  const { cells } = validateRows(loaded.rows, context.rules, context.ctx);
  const changes: (ValidationChange & { stored: StoredCell })[] = [];
  const columnOf = new Map(loaded.rows.flatMap((r) => r.cells.map((c) => [c.id, c.outputColumnId] as const)));
  for (const [id, v] of cells) {
    const stored = loaded.stored.get(id);
    if (!stored) continue;
    if (onlyColumns && !onlyColumns.has(columnOf.get(id) ?? "")) continue;
    if (stored.validationState === v.validationState && sameMsgs(stored.validationMsgs, v.validationMsgs)) continue;
    changes.push({ id, rowId: stored.rowId, ...v, stored });
  }
  await writeChanges(db, changes);
  return changes.map((c) => ({ id: c.id, rowId: c.rowId, validationState: c.validationState, validationMsgs: c.validationMsgs }));
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Re-checks cells and stores what changed. `rowIds` and `documentIds` check those rows (whole documents when
 * the book has an increasing-order rule, since a row's check depends on the row above); `columnIds` and `all`
 * check the whole book, writing only the named columns. `touched` adds the rows sharing a changed value in a
 * column with a uniqueness rule. Returns the cells whose state changed.
 */
export async function revalidate(db: Db, bookId: string, scope: RevalidateScope, touched: TouchedValue[] = []): Promise<ValidationChange[]> {
  const bookWide = scope.all === true || scope.columnIds !== undefined;
  const context = await loadValidationContext(db, bookId, undefined, bookWide);
  const enabled = context.rules.filter((r) => r.enabled);
  const changes: ValidationChange[] = [];

  if (scope.all || scope.columnIds) {
    const onlyColumns = scope.columnIds ? new Set(scope.columnIds) : null;
    // Cross-column rules on these columns read other columns of the row: load those too.
    const readColumns = onlyColumns
      ? [...new Set([...onlyColumns, ...enabled.flatMap((r) => (r.kind === "CROSS_COLUMN" && onlyColumns.has(r.outputColumnId) ? [r.params.otherColumnId] : []))])]
      : null;
    const docs = await db.document.findMany({ where: { bookId, deletedAt: null, rows: { some: {} } }, select: { id: true }, orderBy: { id: "asc" }, take: MAX_BOOK_DOCUMENTS });
    for (const batch of chunks(docs.map((d) => d.id), DOCUMENT_BATCH)) {
      const loaded = await loadRows(db, bookId, { documentId: { in: batch } }, readColumns);
      changes.push(...(await validateAndWrite(db, context, loaded, onlyColumns)));
    }
    return changes;
  }

  const rowIds = new Set(scope.rowIds ?? []);
  const documentIds = new Set(scope.documentIds ?? []);
  const uniqueColumns = new Set(enabled.filter((r) => r.kind === "UNIQUE").map((r) => r.outputColumnId));
  // Only the values these rows hold can be duplicates that matter here.
  const check = async (loaded: Awaited<ReturnType<typeof loadRows>>) => {
    const values = [...new Set(loaded.rows.flatMap((r) => r.cells.flatMap((c) => (uniqueColumns.has(c.outputColumnId) && c.currentValue ? [c.currentValue] : []))))];
    const duplicates = uniqueColumns.size > 0 ? await loadDuplicates(db, bookId, [...uniqueColumns], values) : context.ctx.duplicates;
    return validateAndWrite(db, { ...context, ctx: { ...context.ctx, duplicates } }, loaded, null);
  };
  const byColumn = new Map<string, Set<string>>();
  for (const t of touched) {
    if (t.value === null || t.value === "" || !uniqueColumns.has(t.columnId)) continue;
    byColumn.set(t.columnId, (byColumn.get(t.columnId) ?? new Set()).add(t.value));
  }
  for (const [columnId, values] of byColumn) {
    const sharing = await db.cell.findMany({
      where: { outputColumnId: columnId, currentValue: { in: [...values] }, row: { bookId } },
      select: { rowId: true },
      take: MAX_ROWS_PER_LOAD,
    });
    for (const c of sharing) rowIds.add(c.rowId);
  }

  if (enabled.some((r) => r.kind === "MONOTONIC") && rowIds.size > 0) {
    const docs = await db.row.findMany({ where: { id: { in: [...rowIds] } }, select: { documentId: true }, distinct: ["documentId"], take: MAX_BOOK_DOCUMENTS });
    for (const d of docs) documentIds.add(d.documentId);
    rowIds.clear();
  }
  for (const batch of chunks([...documentIds], DOCUMENT_BATCH)) {
    changes.push(...(await check(await loadRows(db, bookId, { documentId: { in: batch } }, null))));
  }
  const loose = [...rowIds].filter(Boolean);
  for (const batch of chunks(loose, 1000)) {
    changes.push(...(await check(await loadRows(db, bookId, { id: { in: batch }, documentId: { notIn: [...documentIds] } }, null))));
  }
  return changes;
}

/** How many cells of the book each rule flags, for the rules list and an unsaved rule's preview. */
export async function ruleFailureCounts(db: Db, bookId: string, rules: ValidationRuleInput[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>(rules.map((r) => [r.id, 0]));
  if (rules.length === 0) return counts;
  const context = await loadValidationContext(db, bookId, rules);
  const columns = [...new Set(rules.flatMap((r) => (r.kind === "CROSS_COLUMN" ? [r.outputColumnId, r.params.otherColumnId] : [r.outputColumnId])))];
  const docs = await db.document.findMany({ where: { bookId, deletedAt: null, rows: { some: {} } }, select: { id: true }, orderBy: { id: "asc" }, take: MAX_BOOK_DOCUMENTS });
  for (const batch of chunks(docs.map((d) => d.id), DOCUMENT_BATCH)) {
    const { rows } = await loadRows(db, bookId, { documentId: { in: batch } }, columns);
    const { ruleHits } = validateRows(rows, context.rules, context.ctx);
    for (const [id, n] of ruleHits) counts.set(id, (counts.get(id) ?? 0) + n);
  }
  return counts;
}
