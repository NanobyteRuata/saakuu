import { createId } from "@paralleldrive/cuid2";
import { Prisma } from "@prisma/client";

import { requireBookAccess, requireUserId } from "@/lib/auth/guards";
import { sortByPosition } from "@/lib/books/column-ops";
import { prisma } from "@/lib/db/client";
import { pageArgs, toPage, type Page } from "@/lib/db/pagination";
import { AppError } from "@/lib/errors";
import { impactHash } from "@/lib/impact";
import type { PaginationInput } from "@/lib/validation";

import { lockTemplate, recomputeConfigState, requireTemplateAccess, type Db } from "./access";
import { summariseRunState, type RunCounts, type RunSummary } from "./config-state";
import { appendPosition } from "./positions";
import {
  MAX_FIELDS,
  MAX_GROUPS,
  type ConfigState,
  type CreateTemplateInput,
  type DeleteTemplatesInput,
  type DuplicateTemplateInput,
  type TemplateKind,
  type UpdateTemplateInput,
} from "./schemas";
import { buildTree, flattenTree } from "./tree";
import { fieldSelect, groupSelect, toFieldView, type DeletedFieldView, type FieldView, type GroupView } from "./views";

export const MAX_TEMPLATES = 200;
const DELETED_FIELDS_LIMIT = 200;

export type TemplateSummary = {
  id: string;
  name: string;
  kind: TemplateKind;
  configState: ConfigState;
  fieldCount: number;
  documentCount: number;
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
  groups: GroupView[];
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
  photos: number;
  rows: number;
  editedCells: number;
};

async function photoCounts(db: Db, templateIds: string[]): Promise<Map<string, number>> {
  if (templateIds.length === 0) return new Map();
  const rows = await db.$queryRaw<{ templateId: string; n: number }[]>`
    SELECT d."templateId" AS "templateId", count(p.id)::int AS n
    FROM "Photo" p JOIN "Document" d ON d.id = p."documentId"
    WHERE d."templateId" IN (${Prisma.join(templateIds)}) AND d."deletedAt" IS NULL
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
      _count: { select: { fields: { where: { deletedAt: null } }, documents: { where: { deletedAt: null } } } },
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
          by: ["templateId", "runState"],
          where: { templateId: { in: ids }, deletedAt: null },
          _count: { _all: true },
        }),
  ]);
  const runs = new Map<string, RunCounts>();
  for (const g of runGroups) {
    const counts = runs.get(g.templateId) ?? {};
    counts[g.runState] = g._count._all;
    runs.set(g.templateId, counts);
  }
  return {
    items: items.map((t) => ({
      id: t.id,
      name: t.name,
      kind: t.kind,
      configState: t.configState,
      fieldCount: t._count.fields,
      documentCount: t._count.documents,
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
    },
  });
  const groups = await db.fieldGroup.findMany({ where: { templateId }, select: groupSelect, take: MAX_GROUPS });
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
  const documentCount = await db.document.count({ where: { templateId, deletedAt: null } });
  const photos = await photoCounts(db, [templateId]);

  return {
    ...t,
    updatedAt: t.updatedAt.toISOString(),
    groups: sortByPosition(groups),
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

async function nextTemplatePosition(db: Db, bookId: string): Promise<string> {
  const existing = await db.template.findMany({ where: { bookId }, select: { id: true, position: true }, take: 5000 });
  return appendPosition(existing);
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

    await tx.template.update({
      where: { id: templateId },
      data: { ...rest, ...(sequenceFieldId !== undefined ? { sequenceFieldId } : {}) },
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
  const documents = await db.document.count({ where: liveDocuments });
  const photos = await db.photo.count({ where: { document: liveDocuments } });
  const rows = await db.row.count({ where: { document: liveDocuments } });
  const editedCells = await db.cell.count({ where: { isEdited: true, row: { document: liveDocuments } } });
  const counts = { templates: unique.length, documents, photos, rows, editedCells };
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

/**
 * Copies a template's live source layer (groups, fields, anchors, instructions) with new ids,
 * optionally as the other kind. This is the answer to "switch Form ↔ Table", which is refused.
 * Mappings are copied only on request, and only those whose inputs and column are all live.
 */
export async function duplicateTemplate(
  userId: string,
  templateId: string,
  input: DuplicateTemplateInput,
): Promise<{ id: string; skippedMappings: number }> {
  const { bookId } = await requireTemplateAccess(userId, templateId);
  return prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Book" WHERE id = ${bookId} FOR UPDATE`;
      const count = await tx.template.count({ where: { bookId, deletedAt: null } });
      if (count >= MAX_TEMPLATES) throw new AppError("VALIDATION", `A book can have up to ${MAX_TEMPLATES} templates.`);

      const source = await tx.template.findUniqueOrThrow({
        where: { id: templateId },
        select: {
          name: true,
          kind: true,
          modelOverride: true,
          anchors: true,
          languageHint: true,
          instructions: true,
          sequenceFieldId: true,
        },
      });
      const groups = await tx.fieldGroup.findMany({ where: { templateId }, select: groupSelect, take: MAX_GROUPS });
      const fields = await tx.field.findMany({ where: { templateId, deletedAt: null }, select: fieldSelect, take: MAX_FIELDS });
      const kind = input.kind ?? source.kind;

      const newTemplateId = createId();
      const groupIds = new Map(groups.map((g) => [g.id, createId()]));
      const fieldIds = new Map(fields.map((f) => [f.id, createId()]));
      const sequenceFieldId =
        kind === "TABLE" && source.sequenceFieldId ? (fieldIds.get(source.sequenceFieldId) ?? null) : null;

      await tx.template.create({
        data: {
          id: newTemplateId,
          bookId,
          name: input.name ?? `${source.name} (copy)`,
          kind,
          modelOverride: source.modelOverride,
          anchors: source.anchors,
          languageHint: source.languageHint,
          instructions: source.instructions,
          sequenceFieldId,
          position: await nextTemplatePosition(tx, bookId),
        },
      });
      // Pre-order, so every parent row is inserted before its children.
      await tx.fieldGroup.createMany({
        data: flattenTree(buildTree(groups, fields)).flatMap((n) =>
          n.kind === "group"
            ? [
                {
                  id: groupIds.get(n.id) ?? createId(),
                  templateId: newTemplateId,
                  parentGroupId: n.parentId === null ? null : (groupIds.get(n.parentId) ?? null),
                  labelSource: n.group.labelSource,
                  labelMeaning: n.group.labelMeaning,
                  position: n.group.position,
                  selection: n.group.selection,
                  noneMarked: n.group.noneMarked,
                  multipleMarked: n.group.multipleMarked,
                  note: n.group.note,
                },
              ]
            : [],
        ),
      });
      await tx.field.createMany({
        data: fields.map((f) => {
          const id = fieldIds.get(f.id) ?? createId();
          return {
            id,
            templateId: newTemplateId,
            groupId: f.groupId ? (groupIds.get(f.groupId) ?? null) : null,
            labelSource: f.labelSource,
            labelMeaning: f.labelMeaning,
            dataType: f.dataType,
            mode: f.mode,
            note: f.note,
            choices: f.choices,
            markSymbols: f.markSymbols === null ? Prisma.DbNull : f.markSymbols,
            isSequence: id === sequenceFieldId,
            position: f.position,
          };
        }),
      });

      let skippedMappings = 0;
      if (input.includeMappings) {
        const mappings = await tx.mapping.findMany({
          where: { templateId },
          include: { inputs: { select: { fieldId: true, position: true } }, outputColumn: { select: { deletedAt: true } } },
          take: 1000,
        });
        for (const m of mappings) {
          const inputs = m.inputs.map((i) => ({ fieldId: fieldIds.get(i.fieldId), position: i.position }));
          if (m.outputColumn.deletedAt !== null || inputs.some((i) => i.fieldId === undefined)) {
            skippedMappings++;
            continue;
          }
          const mappingId = createId();
          await tx.mapping.create({
            data: {
              id: mappingId,
              templateId: newTemplateId,
              outputColumnId: m.outputColumnId,
              kind: m.kind,
              state: "OK",
              separator: m.separator,
              splitBy: m.splitBy,
              splitIndex: m.splitIndex,
              splitRegex: m.splitRegex,
              constantValue: m.constantValue,
              expression: m.expression,
              fillDown: m.fillDown,
              position: m.position,
            },
          });
          await tx.mappingInput.createMany({
            data: inputs.flatMap((i) => (i.fieldId ? [{ mappingId, fieldId: i.fieldId, position: i.position }] : [])),
          });
        }
      }

      await recomputeConfigState(tx, newTemplateId);
      return { id: newTemplateId, skippedMappings };
    },
    { timeout: 30_000 },
  );
}
