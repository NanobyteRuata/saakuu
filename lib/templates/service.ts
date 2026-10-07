import { Prisma } from "@prisma/client";

import { requireBookAccess, requireUserId } from "@/lib/auth/guards";
import { sortByPosition } from "@/lib/books/column-ops";
import { prisma } from "@/lib/db/client";
import { pageArgs, toPage, type Page } from "@/lib/db/pagination";
import { COUNTING_DOC_SQL, countingDocumentWhere } from "@/lib/db/scope";
import { AppError } from "@/lib/errors";
import { impactHash } from "@/lib/impact";
import type { PaginationInput } from "@/lib/validation";

import { lockTemplate, requireTemplateAccess, type Db } from "./access";
import { summariseRunState, type RunCounts, type RunSummary } from "./config-state";
import { copyTemplateInto, nextTemplatePosition, type TemplateCopy } from "./copy";
import {
  MAX_FIELDS,
  type ConfigState,
  type CreateTemplateInput,
  type DeleteTemplatesInput,
  type DuplicateTemplateInput,
  type TemplateKind,
  MAX_TEMPLATES,
  type UpdateTemplateInput,
} from "./schemas";
import { fieldSelect, toFieldView, type DeletedFieldView, type FieldView } from "./views";

export { MAX_TEMPLATES };

const DELETED_FIELDS_LIMIT = 200;

export type TemplateSummary = {
  id: string;
  name: string;
  kind: TemplateKind;
  configState: ConfigState;
  fieldCount: number;
  documentCount: number;
  /** Pages uploaded to build the template against, counted apart from its documents (decision 71). */
  specimenCount: number;
  photoCount: number;
  run: RunSummary;
  updatedAt: string;
};

export type TemplateDetail = {
  id: string;
  bookId: string;
  name: string;
  kind: TemplateKind;
  configState: ConfigState;
  modelOverride: string | null;
  doubleExtraction: boolean;
  anchors: string[];
  languageHint: string | null;
  instructions: string | null;
  sequenceFieldId: string | null;
  updatedAt: string;
  /** Decision 78: a test reading older than this was read with different fields. */
  fieldsChangedAt: string;
  fields: FieldView[];
  deletedFields: DeletedFieldView[];
  mappingCount: number;
  brokenMappingCount: number;
  unmappedFieldCount: number;
  documentCount: number;
  photoCount: number;
};

export type TemplatesDeleteImpact = {
  impactHash: string;
  templates: number;
  documents: number;
  /** Counted apart from documents: they live in the template, not in Documents (decision 78). */
  specimens: number;
  photos: number;
  rows: number;
  editedCells: number;
};

async function photoCounts(db: Db, templateIds: string[]): Promise<Map<string, number>> {
  if (templateIds.length === 0) return new Map();
  const rows = await db.$queryRaw<{ templateId: string; n: number }[]>`
    SELECT d."templateId" AS "templateId", count(p.id)::int AS n
    FROM "Photo" p JOIN "Document" d ON d.id = p."documentId"
    WHERE d."templateId" IN (${Prisma.join(templateIds)}) AND ${COUNTING_DOC_SQL}
    GROUP BY d."templateId"`;
  return new Map(rows.map((r) => [r.templateId, r.n]));
}

export async function listTemplates(userId: string, bookId: string, page: PaginationInput): Promise<Page<TemplateSummary>> {
  await requireBookAccess(userId, bookId);
  const templates = await prisma.template.findMany({
    where: { bookId, deletedAt: null },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      name: true,
      kind: true,
      configState: true,
      updatedAt: true,
      _count: { select: { fields: { where: { deletedAt: null } } } },
    },
    ...pageArgs(page),
  });
  const { items, nextCursor } = toPage(templates, page.limit);
  const ids = items.map((t) => t.id);
  const [photos, runGroups] = await Promise.all([
    photoCounts(prisma, ids),
    ids.length === 0
      ? Promise.resolve([])
      : prisma.document.groupBy({
          // One pass gives all three numbers a card shows: documents, specimens, and the run states
          // of the documents only — a specimen's run says nothing about the work left in a template.
          by: ["templateId", "runState", "isSpecimen"],
          where: { templateId: { in: ids }, deletedAt: null },
          _count: { _all: true },
        }),
  ]);
  const runs = new Map<string, RunCounts>();
  const documentCounts = new Map<string, number>();
  const specimenCounts = new Map<string, number>();
  for (const g of runGroups) {
    const tally = g.isSpecimen ? specimenCounts : documentCounts;
    tally.set(g.templateId, (tally.get(g.templateId) ?? 0) + g._count._all);
    if (g.isSpecimen) continue;
    const counts = runs.get(g.templateId) ?? {};
    counts[g.runState] = (counts[g.runState] ?? 0) + g._count._all;
    runs.set(g.templateId, counts);
  }
  return {
    items: items.map((t) => ({
      id: t.id,
      name: t.name,
      kind: t.kind,
      configState: t.configState,
      fieldCount: t._count.fields,
      documentCount: documentCounts.get(t.id) ?? 0,
      specimenCount: specimenCounts.get(t.id) ?? 0,
      photoCount: photos.get(t.id) ?? 0,
      run: summariseRunState(runs.get(t.id) ?? {}),
      updatedAt: t.updatedAt.toISOString(),
    })),
    nextCursor,
  };
}

async function loadTemplateDetail(db: Db, templateId: string): Promise<TemplateDetail> {
  const t = await db.template.findUniqueOrThrow({
    where: { id: templateId },
    select: {
      id: true,
      bookId: true,
      name: true,
      kind: true,
      configState: true,
      modelOverride: true,
      doubleExtraction: true,
      anchors: true,
      languageHint: true,
      instructions: true,
      sequenceFieldId: true,
      updatedAt: true,
      fieldsChangedAt: true,
    },
  });
  const fields = await db.field.findMany({ where: { templateId, deletedAt: null }, select: fieldSelect, take: MAX_FIELDS });
  const deleted = await db.field.findMany({
    where: { templateId, deletedAt: { not: null } },
    select: { ...fieldSelect, deletedAt: true },
    orderBy: [{ deletedAt: "desc" }, { id: "asc" }],
    take: DELETED_FIELDS_LIMIT,
  });
  const mappingCount = await db.mapping.count({ where: { templateId } });
  const brokenMappingCount = await db.mapping.count({ where: { templateId, state: "BROKEN" } });
  const unmappedFieldCount = await db.field.count({
    where: { templateId, deletedAt: null, mode: { not: "SKIP" }, mappingInputs: { none: {} } },
  });
  const documentCount = await db.document.count({ where: { templateId, ...countingDocumentWhere } });
  const photos = await photoCounts(db, [templateId]);

  return {
    ...t,
    updatedAt: t.updatedAt.toISOString(),
    fieldsChangedAt: t.fieldsChangedAt.toISOString(),
    fields: sortByPosition(fields).map(toFieldView),
    deletedFields: deleted.map(({ deletedAt, ...f }) => ({
      ...toFieldView(f),
      deletedAt: (deletedAt ?? new Date()).toISOString(),
    })),
    mappingCount,
    brokenMappingCount,
    unmappedFieldCount,
    documentCount,
    photoCount: photos.get(templateId) ?? 0,
  };
}

export async function getTemplate(userId: string, templateId: string): Promise<TemplateDetail> {
  await requireTemplateAccess(userId, templateId);
  return loadTemplateDetail(prisma, templateId);
}

export async function createTemplate(userId: string, bookId: string, input: CreateTemplateInput): Promise<{ id: string }> {
  await requireBookAccess(userId, bookId);
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Book" WHERE id = ${bookId} FOR UPDATE`;
    const count = await tx.template.count({ where: { bookId, deletedAt: null } });
    if (count >= MAX_TEMPLATES) throw new AppError("VALIDATION", `A book can have up to ${MAX_TEMPLATES} templates.`);
    return tx.template.create({
      data: {
        bookId,
        name: input.name,
        kind: input.kind,
        modelOverride: input.modelOverride ?? null,
        position: await nextTemplatePosition(tx, bookId),
      },
      select: { id: true },
    });
  });
}

export async function updateTemplate(userId: string, templateId: string, input: UpdateTemplateInput): Promise<TemplateDetail> {
  await requireTemplateAccess(userId, templateId);
  return prisma.$transaction(async (tx) => {
    await lockTemplate(tx, templateId);
    // `kind` never reaches here: the schema rejects it.
    const { sequenceFieldId, ...rest } = input;

    if (sequenceFieldId !== undefined) {
      const template = await tx.template.findUniqueOrThrow({ where: { id: templateId }, select: { kind: true } });
      if (sequenceFieldId !== null) {
        if (template.kind !== "TABLE") {
          throw new AppError("VALIDATION", "Only table templates have a sequence field.");
        }
        const field = await tx.field.findFirst({
          where: { id: sequenceFieldId, templateId, deletedAt: null },
          select: { mode: true, labelSource: true },
        });
        if (!field) throw new AppError("VALIDATION", "That field isn't part of this template any more. Reload and try again.");
        if (field.mode !== "EXTRACT") {
          throw new AppError("VALIDATION", `"${field.labelSource}" isn't read by the AI, so it can't be the sequence field.`);
        }
      }
      await tx.field.updateMany({ where: { templateId, isSequence: true }, data: { isSequence: false } });
      if (sequenceFieldId !== null) {
        await tx.field.update({ where: { id: sequenceFieldId }, data: { isSequence: true } });
      }
    }

    // What goes into the prompt makes a test reading stale (decision 78); the name, model and anchors don't.
    const touchesReading = rest.languageHint !== undefined || rest.instructions !== undefined || sequenceFieldId !== undefined;
    const before = touchesReading
      ? await tx.template.findUniqueOrThrow({
          where: { id: templateId },
          select: { languageHint: true, instructions: true, sequenceFieldId: true },
        })
      : null;
    const readingChanged =
      before !== null &&
      ((rest.languageHint !== undefined && rest.languageHint !== before.languageHint) ||
        (rest.instructions !== undefined && rest.instructions !== before.instructions) ||
        (sequenceFieldId !== undefined && sequenceFieldId !== before.sequenceFieldId));

    await tx.template.update({
      where: { id: templateId },
      data: {
        ...rest,
        ...(sequenceFieldId !== undefined ? { sequenceFieldId } : {}),
        ...(readingChanged ? { fieldsChangedAt: new Date() } : {}),
      },
    });
    return loadTemplateDetail(tx, templateId);
  });
}

/** Counts for deleting templates. Every id must be a live template the user owns. */
export async function templatesDeleteImpact(userId: string, ids: string[], db: Db = prisma): Promise<TemplatesDeleteImpact> {
  const uid = requireUserId(userId);
  const unique = [...new Set(ids)].sort();
  const owned = await db.template.findMany({
    where: { id: { in: unique }, deletedAt: null, book: { userId: uid, deletedAt: null } },
    select: { id: true },
    take: unique.length,
  });
  if (owned.length !== unique.length) {
    throw new AppError("NOT_FOUND", "One or more of these templates doesn't exist or has already been deleted.");
  }
  const liveDocuments = { templateId: { in: unique }, deletedAt: null } satisfies Prisma.DocumentWhereInput;
  const documents = await db.document.count({ where: { ...liveDocuments, isSpecimen: false } });
  const specimens = await db.document.count({ where: { ...liveDocuments, isSpecimen: true } });
  const photos = await db.photo.count({ where: { deletedAt: null, document: liveDocuments } });
  const rows = await db.row.count({ where: { deletedAt: null, document: liveDocuments } });
  const editedCells = await db.cell.count({ where: { isEdited: true, row: { deletedAt: null, document: liveDocuments } } });
  const counts = { templates: unique.length, documents, specimens, photos, rows, editedCells };
  return { impactHash: impactHash({ action: "templates.delete", ids: unique, ...counts }), ...counts };
}

/** Soft-deletes templates and their documents. */
export async function deleteTemplates(userId: string, input: DeleteTemplatesInput): Promise<{ deleted: number }> {
  const uid = requireUserId(userId);
  return prisma.$transaction(async (tx) => {
    const unique = [...new Set(input.ids)].sort();
    for (const id of unique) {
      await tx.$queryRaw`SELECT id FROM "Template" WHERE id = ${id} FOR UPDATE`;
    }
    const impact = await templatesDeleteImpact(uid, unique, tx);
    if (impact.impactHash !== input.impactHash) {
      throw new AppError("CONFLICT", "These templates changed since you reviewed the deletion. Review it again.");
    }
    const now = new Date();
    await tx.document.updateMany({ where: { templateId: { in: unique }, deletedAt: null }, data: { deletedAt: now } });
    const { count } = await tx.template.updateMany({ where: { id: { in: unique }, deletedAt: null }, data: { deletedAt: now } });
    return { deleted: count };
  });
}

export type TemplateCopySummary = { fields: number; mappings: number };

/** What a copy carries and what it leaves behind, for the counted confirmation (docs/06 Phase 17). */
export async function templateCopySummary(userId: string, templateId: string): Promise<TemplateCopySummary> {
  await requireTemplateAccess(userId, templateId);
  const [fields, mappings] = await Promise.all([
    prisma.field.count({ where: { templateId, deletedAt: null } }),
    prisma.mapping.count({ where: { templateId } }),
  ]);
  return { fields, mappings };
}

export type DuplicateResult = TemplateCopy & { bookId: string; mappingsLeftBehind: number };

/**
 * Copies a template's live source layer (fields, anchors, instructions) with new ids, optionally as
 * the other kind — the answer to "switch Form ↔ Table", which is refused — and optionally into another book
 * the user owns (Phase 17). Within a book, mappings are copied on request, only those whose inputs and
 * column are all live. Into another book they never travel: they name this book's columns (decision 3).
 */
export async function duplicateTemplate(userId: string, templateId: string, input: DuplicateTemplateInput): Promise<DuplicateResult> {
  const { bookId: sourceBookId } = await requireTemplateAccess(userId, templateId);
  const bookId = input.targetBookId ?? sourceBookId;
  const crossBook = bookId !== sourceBookId;
  if (crossBook) await requireBookAccess(userId, bookId);
  return prisma.$transaction(
    async (tx) => {
      // The access check ran before the transaction; a book deleted since then must not receive the copy.
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Book" WHERE id = ${bookId} AND "deletedAt" IS NULL FOR UPDATE`;
      if (locked.length === 0) throw new AppError("NOT_FOUND", "That book doesn't exist or you don't have access to it.");
      const count = await tx.template.count({ where: { bookId, deletedAt: null } });
      if (count >= MAX_TEMPLATES) throw new AppError("VALIDATION", `A book can have up to ${MAX_TEMPLATES} templates.`);
      const source = await tx.template.findUniqueOrThrow({ where: { id: templateId }, select: { name: true } });
      const copy = await copyTemplateInto(tx, {
        sourceTemplateId: templateId,
        targetBookId: bookId,
        name: input.name ?? (crossBook ? source.name : `${source.name} (copy)`),
        ...(input.kind ? { kind: input.kind } : {}),
        columnMap: crossBook || !input.includeMappings ? null : "same",
      });
      const mappingsLeftBehind = crossBook ? await tx.mapping.count({ where: { templateId } }) : 0;
      return { ...copy, bookId, mappingsLeftBehind };
    },
    { timeout: 30_000 },
  );
}
