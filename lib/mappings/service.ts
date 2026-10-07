import { Prisma } from "@prisma/client";
import { generateNKeysBetween } from "fractional-indexing";

import { requireUserId } from "@/lib/auth/guards";
import { createEmptyCells, loadColumns } from "@/lib/books/columns-service";
import { proposeColumns, type ProposedColumn } from "@/lib/books/column-proposal";
import { MAX_COLUMNS, type ColumnType } from "@/lib/books/schemas";
import { prisma } from "@/lib/db/client";
import { AppError } from "@/lib/errors";
import { impactHash } from "@/lib/impact";
import { log } from "@/lib/log";
import {
  discardQueue,
  enqueueTemplateTransform,
  getLastTemplateTransformRun,
  getTemplateTransformStatus,
  QUEUES,
  type TransformRunRecord,
} from "@/lib/queue";
import { lockTemplate, recomputeConfigState, requireTemplateAccess, type Db } from "@/lib/templates/access";
import { appendPosition } from "@/lib/templates/positions";
import { MAX_FIELDS, type ConfigState } from "@/lib/templates/schemas";
import { loadSourceFields } from "@/lib/templates/source-fields";
import { parseExpression } from "@/lib/transform/expression";
import type { DocumentFlag } from "@/lib/transform/flags";
import { mappingProblem, tidyMapping, type MappingContext } from "@/lib/transform/mappings";
import { runTransform } from "@/lib/transform/run";
import { loadDocumentRecords, loadTemplateContext, parseManualValues } from "@/lib/transform/service";
import { requestTemplateTransform } from "@/lib/transform/triggers";
import type { ComputedCell, TransformMapping, VoidReason } from "@/lib/transform/types";

import { MAX_MAPPINGS, type DeleteMappingInput, type MappingDraft, type MappingSourceInput, type PreviewMappingsInput } from "./schemas";
import { recomputeMappingStates } from "./state";
import { mappingSelect, rowTickRules, rowToTransformMapping, toSourceView, toTransformSource, type MappingRow, type MappingView } from "./views";

/**
 * Mapping CRUD, preview and rebuilds (docs/04 → Mappings). Every save is checked with the same rules
 * the transform uses, so a mapping that saves is a mapping that works. Saving never touches rows
 * directly: it queues a rebuild, which never overwrites an edited cell.
 */

export type ColumnOption = { id: string; key: string; label: string; dataType: ColumnType; enumValues: string[] };

export type MappingsOverview = {
  mappings: MappingView[];
  columns: ColumnOption[];
  /** Documents of the template with raw records: what a rebuild covers. */
  extractedDocuments: number;
};

type Context = MappingContext & { columnLabels: Map<string, string> };

async function requireMappingAccess(userId: string, mappingId: string): Promise<{ id: string; templateId: string; bookId: string }> {
  const uid = requireUserId(userId);
  const mapping = await prisma.mapping.findFirst({
    where: { id: mappingId, template: { deletedAt: null, book: { userId: uid, deletedAt: null } } },
    select: { id: true, templateId: true, template: { select: { bookId: true } } },
  });
  if (!mapping) throw new AppError("NOT_FOUND", "That mapping doesn't exist or was deleted.");
  return { id: mapping.id, templateId: mapping.templateId, bookId: mapping.template.bookId };
}

async function loadContext(db: Db, templateId: string, bookId: string): Promise<Context & { columns: ColumnOption[] }> {
  const fields = await loadSourceFields(db, templateId);
  const columns = await loadColumns(db, bookId);
  const deleted = await db.field.findMany({ where: { templateId, deletedAt: { not: null } }, select: { id: true, labelSource: true }, take: MAX_FIELDS });
  return {
    fields,
    columns: columns.map((c) => ({ id: c.id, key: c.key, label: c.label, dataType: c.dataType, enumValues: c.enumValues })),
    liveColumnIds: new Set(columns.map((c) => c.id)),
    columnLabels: new Map(columns.map((c) => [c.id, c.label])),
    deletedFieldLabels: new Map(deleted.map((f) => [f.id, f.labelSource])),
  };
}

function toView(row: MappingRow, ctx: Context): MappingView {
  return {
    id: row.id,
    outputColumnId: row.outputColumnId,
    kind: row.kind,
    state: row.state,
    separator: row.separator,
    splitBy: row.splitBy,
    splitIndex: row.splitIndex,
    splitRegex: row.splitRegex,
    constantValue: row.constantValue,
    expression: row.expression,
    ticks: rowTickRules(row),
    fillDown: row.fillDown,
    position: row.position,
    inputs: row.inputs.map(toSourceView),
    problem: mappingProblem(rowToTransformMapping(row), ctx),
  };
}

async function loadMappingRows(db: Db, templateId: string): Promise<MappingRow[]> {
  const rows = await db.mapping.findMany({ where: { templateId }, select: mappingSelect, take: MAX_MAPPINGS });
  return rows.sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : a.id < b.id ? -1 : 1));
}

export async function listMappings(userId: string, templateId: string): Promise<MappingsOverview> {
  const { bookId } = await requireTemplateAccess(userId, templateId);
  const ctx = await loadContext(prisma, templateId, bookId);
  const rows = await loadMappingRows(prisma, templateId);
  const extractedDocuments = await prisma.document.count({ where: { templateId, deletedAt: null, records: { some: {} } } });
  return { mappings: rows.map((r) => toView(r, ctx)), columns: ctx.columns, extractedDocuments };
}

const blankToNull = (v: string | null) => (v === null || v === "" ? null : v);

/**
 * A draft as the transform sees it. For an expression the inputs are its `{id}` references. In a
 * From ticks mapping a blank value means "write the field's own words", and a blank name means
 * "call it by the column's label".
 */
function resolveDraft(draft: MappingDraft): { mapping: Omit<TransformMapping, "id">; sources: MappingSourceInput[] } {
  let sources = draft.inputs;
  if (draft.kind === "EXPRESSION" && draft.expression !== null) {
    const parsed = parseExpression(draft.expression);
    if (parsed.ok) {
      sources = parsed.value.refs.map((id): MappingSourceInput => ({ id, tickValue: null }));
    }
  }
  if (draft.kind === "CONSTANT") sources = [];
  sources = sources.map((s) => ({ id: s.id, tickValue: draft.kind === "TICKS" && s.tickValue !== null && s.tickValue.trim() !== "" ? s.tickValue : null }));
  const mapping = tidyMapping({
    outputColumnId: draft.outputColumnId,
    kind: draft.kind,
    separator: draft.separator,
    splitBy: blankToNull(draft.splitBy),
    splitIndex: draft.splitIndex,
    splitRegex: blankToNull(draft.splitRegex),
    constantValue: draft.constantValue,
    expression: blankToNull(draft.expression),
    ticks: draft.ticks === null ? null : { ...draft.ticks, noneValue: blankToNull(draft.ticks.noneValue), label: blankToNull(draft.ticks.label?.trim() ?? null) },
    fillDown: draft.fillDown,
    inputs: sources.map(toTransformSource),
  });
  return { mapping, sources };
}

/** Why a draft can't be saved, in plain language; null when it can. */
function draftProblem(
  mapping: Omit<TransformMapping, "id">,
  mappingId: string | null,
  ctx: Context,
  others: { id: string; outputColumnId: string }[],
): string | null {
  if (!ctx.liveColumnIds.has(mapping.outputColumnId)) return "That output column was deleted. Reload and try again.";
  if (others.some((m) => m.outputColumnId === mapping.outputColumnId && m.id !== mappingId)) {
    return `“${ctx.columnLabels.get(mapping.outputColumnId) ?? ""}” is already filled by another mapping in this template. Change that mapping instead.`;
  }
  return mappingProblem({ id: mappingId ?? "draft", ...mapping }, ctx);
}

function inputRows(sources: MappingSourceInput[]) {
  return sources.map((s, position) => ({ fieldId: s.id, position, tickValue: s.tickValue }));
}

function mappingData(m: Omit<TransformMapping, "id">) {
  return {
    outputColumnId: m.outputColumnId,
    kind: m.kind,
    state: "OK" as const,
    separator: m.separator,
    splitBy: m.splitBy,
    splitIndex: m.splitIndex,
    splitRegex: m.splitRegex,
    constantValue: m.constantValue,
    expression: m.expression,
    tickSelection: m.ticks?.selection ?? null,
    noneMarked: m.ticks?.noneMarked ?? null,
    multipleMarked: m.ticks?.multipleMarked ?? null,
    noneValue: m.ticks?.noneValue ?? null,
    tickLabel: m.ticks?.label ?? null,
    fillDown: m.fillDown,
  };
}

export async function createMapping(userId: string, templateId: string, draft: MappingDraft): Promise<MappingView> {
  const { bookId } = await requireTemplateAccess(userId, templateId);
  const view = await prisma.$transaction(async (tx) => {
    await lockTemplate(tx, templateId);
    const others = await tx.mapping.findMany({ where: { templateId }, select: { id: true, outputColumnId: true, position: true }, take: MAX_MAPPINGS });
    if (others.length >= MAX_MAPPINGS) throw new AppError("VALIDATION", `A template can have up to ${MAX_MAPPINGS} mappings.`);
    const ctx = await loadContext(tx, templateId, bookId);
    const { mapping, sources } = resolveDraft(draft);
    const problem = draftProblem(mapping, null, ctx, others);
    if (problem) throw new AppError("VALIDATION", problem);
    const row = await tx.mapping.create({
      data: { templateId, position: appendPosition(others), ...mappingData(mapping), inputs: { create: inputRows(sources) } },
      select: mappingSelect,
    });
    await recomputeConfigState(tx, templateId);
    return toView(row, ctx);
  });
  await requestTemplateTransform(templateId);
  return view;
}

export async function updateMapping(userId: string, mappingId: string, draft: MappingDraft): Promise<MappingView> {
  const { templateId, bookId } = await requireMappingAccess(userId, mappingId);
  const view = await prisma.$transaction(async (tx) => {
    await lockTemplate(tx, templateId);
    const others = await tx.mapping.findMany({ where: { templateId }, select: { id: true, outputColumnId: true }, take: MAX_MAPPINGS });
    if (!others.some((m) => m.id === mappingId)) throw new AppError("NOT_FOUND", "That mapping doesn't exist or was deleted.");
    const ctx = await loadContext(tx, templateId, bookId);
    const { mapping, sources } = resolveDraft(draft);
    const problem = draftProblem(mapping, mappingId, ctx, others);
    if (problem) throw new AppError("VALIDATION", problem);
    await tx.mappingInput.deleteMany({ where: { mappingId } });
    const row = await tx.mapping.update({
      where: { id: mappingId },
      data: { ...mappingData(mapping), inputs: { create: inputRows(sources) } },
      select: mappingSelect,
    });
    await recomputeConfigState(tx, templateId);
    return toView(row, ctx);
  });
  await requestTemplateTransform(templateId);
  return view;
}

// ---------- column proposal ----------

/**
 * Keys read to de-duplicate a proposed one. Soft-deleted columns keep parked keys
 * (`deletedColumnKey`) and the unique index ignores `deletedAt`, so they count. A book past this
 * many keys can still propose: `createColumn` retries a key the database rejects.
 */
const KEY_SCAN = 2000;
/** Retries for a key the scan above didn't know was taken. */
const KEY_ATTEMPTS = 5;

export type ColumnProposal = {
  items: ProposedColumn[];
  /** Columns the book already has, so the dialog can say when the proposal was capped. */
  liveColumns: number;
  maxColumns: number;
};

async function buildProposal(db: Db, templateId: string, bookId: string): Promise<ColumnProposal> {
  const fields = await loadSourceFields(db, templateId);
  const mappings = await db.mapping.findMany({
    where: { templateId },
    select: { inputs: { select: { fieldId: true } } },
    take: MAX_MAPPINGS,
  });
  const mappedFieldIds = new Set(mappings.flatMap((m) => m.inputs.map((i) => i.fieldId)));
  const keys = await db.outputColumn.findMany({ where: { bookId }, select: { key: true }, take: KEY_SCAN });
  const liveColumns = await db.outputColumn.count({ where: { bookId, deletedAt: null } });
  const items = proposeColumns({
    fields,
    mappedFieldIds,
    takenKeys: keys.map((k) => k.key),
    liveColumns,
  });
  return { items, liveColumns, maxColumns: MAX_COLUMNS };
}

/** What `Create columns from this template` would create, for the counted confirmation. */
export async function columnProposal(userId: string, templateId: string): Promise<ColumnProposal> {
  const { bookId } = await requireTemplateAccess(userId, templateId);
  return buildProposal(prisma, templateId, bookId);
}

/** A COPY mapping's draft, with the defaults `mappingDraftSchema` would apply. */
const EMPTY_DRAFT = {
  kind: "COPY",
  inputs: [] as MappingSourceInput[],
  separator: null,
  splitBy: null,
  splitIndex: null,
  splitRegex: null,
  constantValue: null,
  expression: null,
  ticks: null,
  fillDown: true,
} satisfies Omit<MappingDraft, "outputColumnId">;

/** Creates a proposed column, retrying its key if a column outside `KEY_SCAN` already holds it. */
async function createColumn(tx: Db, bookId: string, item: ProposedColumn, position: string): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const key = attempt === 0 ? item.key : `${item.key.slice(0, 58)}_${attempt + 1}`;
    try {
      const column = await tx.outputColumn.create({
        data: { bookId, key, label: item.label, dataType: item.dataType, enumValues: item.enumValues, position },
        select: { id: true },
      });
      return column.id;
    } catch (err) {
      const duplicateKey = err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
      if (!duplicateKey || attempt + 1 >= KEY_ATTEMPTS) throw err;
    }
  }
}

/**
 * Creates one output column and one COPY mapping per unmapped field (docs/06 Phase 10, decision 52).
 * The proposal is recomputed inside the transaction, so a second click finds nothing left to create
 * rather than duplicating the first one's columns.
 */
export async function applyColumnProposal(userId: string, templateId: string): Promise<{ columns: number; mappings: number }> {
  const { bookId } = await requireTemplateAccess(userId, templateId);
  const created = await prisma.$transaction(
    async (tx) => {
      // Same lock order as applyColumnOps: the book first, then the template.
      await tx.$queryRaw`SELECT id FROM "Book" WHERE id = ${bookId} AND "deletedAt" IS NULL FOR UPDATE`;
      await lockTemplate(tx, templateId);

      const { items } = await buildProposal(tx, templateId, bookId);
      if (items.length === 0) return 0;

      const others = await tx.mapping.findMany({ where: { templateId }, select: { id: true, outputColumnId: true, position: true }, take: MAX_MAPPINGS });
      if (others.length + items.length > MAX_MAPPINGS) {
        throw new AppError("VALIDATION", `A template can have up to ${MAX_MAPPINGS} mappings, and this would need ${others.length + items.length}.`);
      }

      const columns = await loadColumns(tx, bookId);
      const columnKeys = generateNKeysBetween(columns.at(-1)?.position ?? null, null, items.length);
      const mappingKeys = generateNKeysBetween(appendPosition(others), null, items.length);

      // 1. The columns, then their cells in one pass over the book's rows.
      const created: { item: ProposedColumn; columnId: string }[] = [];
      for (const [i, item] of items.entries()) {
        const columnId = await createColumn(tx, bookId, item, columnKeys[i] ?? appendPosition(columns));
        created.push({ item, columnId });
      }
      await createEmptyCells(tx, bookId, created.map((c) => c.columnId));

      // 2. The mappings, checked by the same rules every other mapping write goes through, so a
      //    proposal can never write one the editor would refuse.
      const ctx = await loadContext(tx, templateId, bookId);
      const saved = [...others];
      for (const [i, { item, columnId }] of created.entries()) {
        const draft = { ...EMPTY_DRAFT, outputColumnId: columnId, inputs: [{ id: item.fieldId, tickValue: null }] };
        const { mapping, sources } = resolveDraft(draft);
        const problem = draftProblem(mapping, null, ctx, saved);
        if (problem) throw new AppError("VALIDATION", `“${item.label}” can't be mapped: ${problem}`);
        const row = await tx.mapping.create({
          data: {
            templateId,
            position: mappingKeys[i] ?? appendPosition(saved),
            ...mappingData(mapping),
            inputs: { create: inputRows(sources) },
          },
          select: { id: true, outputColumnId: true, position: true },
        });
        saved.push(row);
      }

      await tx.book.update({ where: { id: bookId }, data: { updatedAt: new Date() } });
      await recomputeConfigState(tx, templateId);
      return items.length;
    },
    { timeout: 30_000 },
  );
  if (created > 0) await requestTemplateTransform(templateId);
  return { columns: created, mappings: created };
}

export type MappingDeleteImpact = {
  impactHash: string;
  columnLabel: string;
  /** Documents of this template that have rows. */
  documents: number;
  /** Cells with a value nobody edited: they empty on the rebuild. */
  clearedCells: number;
  /** Cells you edited in that column: they keep your value. */
  editedCells: number;
};

async function computeDeleteImpact(db: Db, mappingId: string, templateId: string): Promise<MappingDeleteImpact> {
  const mapping = await db.mapping.findFirst({
    where: { id: mappingId, templateId },
    select: { outputColumnId: true, outputColumn: { select: { label: true } } },
  });
  if (!mapping) throw new AppError("NOT_FOUND", "That mapping doesn't exist or was deleted.");
  const cells = { outputColumnId: mapping.outputColumnId, row: { deletedAt: null, document: { templateId, deletedAt: null } } } satisfies Prisma.CellWhereInput;
  const clearedCells = await db.cell.count({ where: { ...cells, isEdited: false, NOT: [{ currentValue: null }, { currentValue: "" }] } });
  const editedCells = await db.cell.count({ where: { ...cells, isEdited: true } });
  const documents = await db.document.count({ where: { templateId, deletedAt: null, rows: { some: { deletedAt: null } } } });
  const body = { columnLabel: mapping.outputColumn.label, documents, clearedCells, editedCells };
  return { impactHash: impactHash({ action: "mappings.delete", mappingId, ...body }), ...body };
}

export async function mappingDeleteImpact(userId: string, mappingId: string): Promise<MappingDeleteImpact> {
  const { templateId } = await requireMappingAccess(userId, mappingId);
  return computeDeleteImpact(prisma, mappingId, templateId);
}

export async function deleteMapping(userId: string, mappingId: string, input: DeleteMappingInput): Promise<{ configState: ConfigState }> {
  const { templateId } = await requireMappingAccess(userId, mappingId);
  const configState = await prisma.$transaction(async (tx) => {
    await lockTemplate(tx, templateId);
    const impact = await computeDeleteImpact(tx, mappingId, templateId);
    if (impact.impactHash !== input.impactHash) {
      throw new AppError("CONFLICT", "The rows for this column changed since you reviewed the deletion. Review it again.");
    }
    await tx.mapping.delete({ where: { id: mappingId } });
    return recomputeConfigState(tx, templateId);
  });
  await requestTemplateTransform(templateId);
  return { configState };
}

export type MappingValidation = { mappings: { id: string; state: "OK" | "BROKEN"; problem: string | null }[]; configState: ConfigState };

/** Re-checks every mapping against the current fields and columns and stores the result. */
export async function validateMappings(userId: string, templateId: string): Promise<MappingValidation> {
  const { bookId } = await requireTemplateAccess(userId, templateId);
  return prisma.$transaction(async (tx) => {
    await lockTemplate(tx, templateId);
    await recomputeMappingStates(tx, templateId);
    const configState = await recomputeConfigState(tx, templateId);
    const ctx = await loadContext(tx, templateId, bookId);
    const rows = await loadMappingRows(tx, templateId);
    return { mappings: rows.map((r) => ({ id: r.id, state: r.state, problem: toView(r, ctx).problem })), configState };
  });
}

// ---------- preview ----------

export type PreviewCell = Pick<ComputedCell, "value" | "state" | "inherited" | "validationState" | "validationMsgs">;

export type MappingPreview = {
  /** Most recently extracted documents of the template, to choose from. */
  documents: { id: string; label: string | null }[];
  document: { id: string; label: string | null } | null;
  rows: { recordKey: string; voidReason: VoidReason | null; cells: Record<string, PreviewCell> }[];
  totalRows: number;
  flags: DocumentFlag[];
  /** Why the unsaved mapping can't apply; the preview then shows the saved mappings only. */
  draftProblem: string | null;
};

const PREVIEW_ROWS = 50;
const PREVIEW_DOCUMENTS = 20;

/**
 * The saved mappings, with one unsaved mapping in its place when given, applied to a document's raw
 * values (docs/05 §7 Mapping tab). Pure computation: nothing is written.
 */
export async function previewMappings(userId: string, templateId: string, input: PreviewMappingsInput): Promise<MappingPreview> {
  const { bookId } = await requireTemplateAccess(userId, templateId);
  const context = await loadTemplateContext(prisma, templateId);
  if (!context) throw new AppError("NOT_FOUND", "That template doesn't exist or you don't have access to it.");

  const docSelect = { id: true, label: true, manualValues: true } satisfies Prisma.DocumentSelect;
  const documents = await prisma.document.findMany({
    where: { templateId, deletedAt: null, records: { some: {} } },
    orderBy: [{ lastRunAt: { sort: "desc", nulls: "last" } }, { id: "asc" }],
    take: PREVIEW_DOCUMENTS,
    select: docSelect,
  });
  let doc = input.documentId ? documents.find((d) => d.id === input.documentId) : documents[0];
  if (input.documentId && !doc) {
    doc = (await prisma.document.findFirst({ where: { id: input.documentId, templateId, deletedAt: null }, select: docSelect })) ?? undefined;
    if (!doc) throw new AppError("NOT_FOUND", "That document isn't in this template any more. Choose another.");
  }

  let mappings = context.mappings;
  let problem: string | null = null;
  if (input.draft) {
    const ctx = await loadContext(prisma, templateId, bookId);
    const { id, ...draft } = input.draft;
    const { mapping } = resolveDraft(draft);
    problem = draftProblem(mapping, id, ctx, context.mappings);
    if (problem === null) {
      const drafted: TransformMapping = { id: id ?? "draft", ...mapping };
      mappings = [drafted, ...context.mappings.filter((m) => m.id !== drafted.id)];
    }
  }

  const base = { documents: documents.map((d) => ({ id: d.id, label: d.label })), draftProblem: problem };
  if (!doc) return { ...base, document: null, rows: [], totalRows: 0, flags: [] };
  const records = await loadDocumentRecords(prisma, doc.id);
  const result = runTransform({ ...context, mappings, manualValues: parseManualValues(doc.manualValues), records });
  return {
    ...base,
    document: { id: doc.id, label: doc.label },
    totalRows: result.rows.length,
    flags: result.flags,
    rows: result.rows.slice(0, PREVIEW_ROWS).map((r) => ({
      recordKey: r.recordKey,
      voidReason: r.voidReason,
      cells: Object.fromEntries(
        r.cells.map((c) => [c.outputColumnId, { value: c.value, state: c.state, inherited: c.inherited, validationState: c.validationState, validationMsgs: c.validationMsgs }]),
      ),
    })),
  };
}

// ---------- rebuilds ----------

export type RetransformStatus = {
  state: "idle" | "queued" | "running";
  done: number;
  total: number;
  /** When idle: how the last rebuild went, so failed documents aren't silent. */
  lastRun: TransformRunRecord | null;
};

export async function getRetransformStatus(userId: string, templateId: string): Promise<RetransformStatus> {
  await requireTemplateAccess(userId, templateId);
  const fail = (what: string) => (err: unknown) => {
    log.error(what, err, { templateId });
    return null;
  };
  const status = await getTemplateTransformStatus(templateId).catch(fail("transform status failed"));
  if (!status) {
    const lastRun = await getLastTemplateTransformRun(templateId).catch(fail("transform last run unreadable"));
    return { state: "idle", done: 0, total: 0, lastRun };
  }
  return { state: status.running ? "running" : "queued", done: status.progress?.done ?? 0, total: status.progress?.total ?? 0, lastRun: null };
}

/** Rebuilds the template's rows from their raw values, queued (docs/04 → retransform). No AI cost. */
export async function requestRetransform(userId: string, templateId: string): Promise<RetransformStatus> {
  await requireTemplateAccess(userId, templateId);
  try {
    await enqueueTemplateTransform({ templateId });
  } catch (err) {
    log.error("transform enqueue failed", err, { templateId });
    await discardQueue(QUEUES.transform);
    throw new AppError("INTERNAL", "Rows couldn't be queued for rebuilding. Try again in a moment.");
  }
  return getRetransformStatus(userId, templateId);
}
