import type { Prisma } from "@prisma/client";

import { requireUserId } from "@/lib/auth/guards";
import { prisma } from "@/lib/db/client";
import { AppError } from "@/lib/errors";
import { impactHash, type BrokenMapping, type ImpactReport } from "@/lib/impact";
import { recomputeMappingStates } from "@/lib/mappings/state";
import { requestTemplateTransform } from "@/lib/transform/triggers";

import { lockTemplate, markSourceChanged, recomputeConfigState, requireFieldAccess, type Db } from "./access";
import { positionAfter, type Positioned } from "./positions";
import { MAX_FIELDS, type ConfigState, type DeleteFieldsInput } from "./schemas";
import { applyPositionRewrites, loadSourceFields } from "./source-fields";
import { fieldSelect, toFieldView, type FieldView } from "./views";

/**
 * Soft delete and restore of fields (docs/01 §8, docs/02 invariant 2).
 *
 * Deleting never removes data: the Field row stays with `deletedAt` set, so its RawValues and
 * MappingInputs keep pointing at it. Mappings that read it turn BROKEN (the template becomes
 * Conflicted). If it was the sequence field, `Template.sequenceFieldId` is cleared but
 * `Field.isSequence` stays set so a restore can put the designation back.
 */

const MAPPING_LIMIT = 1000;

export type FieldsDeleteImpact = ImpactReport & {
  templateId: string;
  fields: number;
  fieldLabels: string[];
  /** Raw values read for these fields. Kept, and reattached on restore. */
  rawValues: number;
  clearsSequence: boolean;
};

export async function fieldsDeleteImpact(userId: string, ids: string[], db: Db = prisma): Promise<FieldsDeleteImpact> {
  const uid = requireUserId(userId);
  const unique = [...new Set(ids)].sort();
  const fields = await db.field.findMany({
    where: { id: { in: unique }, deletedAt: null, template: { deletedAt: null, book: { userId: uid, deletedAt: null } } },
    select: { id: true, templateId: true, labelSource: true },
    orderBy: { id: "asc" },
    take: unique.length,
  });
  if (fields.length !== unique.length) {
    throw new AppError("NOT_FOUND", "One or more of these fields doesn't exist or was already deleted.");
  }
  const templateIds = new Set(fields.map((f) => f.templateId));
  const templateId = fields[0]?.templateId;
  if (templateIds.size !== 1 || templateId === undefined) {
    throw new AppError("VALIDATION", "Delete fields from one template at a time.");
  }

  const template = await db.template.findUniqueOrThrow({ where: { id: templateId }, select: { name: true, sequenceFieldId: true } });
  const usesFields = { inputs: { some: { fieldId: { in: unique } } } } satisfies Prisma.MappingWhereInput;
  const breaking = await db.mapping.findMany({
    where: { templateId, state: "OK", ...usesFields },
    select: { outputColumnId: true, outputColumn: { select: { label: true, deletedAt: true } } },
    orderBy: { id: "asc" },
    take: MAPPING_LIMIT,
  });
  const brokenMappings: BrokenMapping[] = breaking.map((m) => ({
    templateId,
    templateName: template.name,
    columnLabel: m.outputColumn.label,
    reason: "It reads a field that is being deleted.",
  }));

  // A column empties on the next transform when no working mapping from this template is left for it.
  const columnIds = [...new Set(breaking.filter((m) => m.outputColumn.deletedAt === null).map((m) => m.outputColumnId))].sort();
  let clearedColumns: string[] = [];
  let affectedRows = 0;
  let affectedCells = 0;
  let editedCells = 0;
  let reviewedCells = 0;
  if (columnIds.length > 0) {
    const survivors = await db.mapping.findMany({
      where: { templateId, state: "OK", outputColumnId: { in: columnIds }, NOT: usesFields },
      select: { outputColumnId: true },
      take: MAPPING_LIMIT,
    });
    const stillFilled = new Set(survivors.map((m) => m.outputColumnId));
    clearedColumns = columnIds.filter((id) => !stillFilled.has(id));
  }
  if (clearedColumns.length > 0) {
    const affected = {
      outputColumnId: { in: clearedColumns },
      row: { deletedAt: null, document: { templateId, deletedAt: null } },
      OR: [{ NOT: [{ currentValue: null }, { currentValue: "" }] }, { isEdited: true }],
    } satisfies Prisma.CellWhereInput;
    affectedCells = await db.cell.count({ where: affected });
    editedCells = await db.cell.count({ where: { ...affected, isEdited: true } });
    reviewedCells = await db.cell.count({ where: { ...affected, isReviewed: true } });
    affectedRows = await db.row.count({
      where: { deletedAt: null, document: { templateId, deletedAt: null }, cells: { some: { outputColumnId: { in: clearedColumns }, OR: affected.OR } } },
    });
  }

  const rawValues = await db.rawValue.count({ where: { fieldId: { in: unique } } });
  const clearsSequence = template.sequenceFieldId !== null && unique.includes(template.sequenceFieldId);

  const body = {
    severity: brokenMappings.length > 0 ? ("DESTRUCTIVE" as const) : ("SAFE" as const),
    brokenMappings,
    clearedColumns,
    affectedRows,
    affectedCells,
    editedCells,
    reviewedCells,
    // Deleting fields never adds a column; the table's own report carries this.
    fillableTemplates: [],
    templateId,
    fields: unique.length,
    fieldLabels: fields.map((f) => f.labelSource),
    rawValues,
    clearsSequence,
  };
  return { impactHash: impactHash({ action: "fields.delete", ids: unique, ...body }), ...body };
}

export async function deleteFields(
  userId: string,
  input: DeleteFieldsInput,
): Promise<{ deleted: number; templateId: string; configState: ConfigState }> {
  const uid = requireUserId(userId);
  const first = input.ids[0];
  if (first === undefined) throw new AppError("VALIDATION", "Choose at least one field.");
  const { templateId } = await requireFieldAccess(uid, first, false);

  const result = await prisma.$transaction(async (tx) => {
    await lockTemplate(tx, templateId);
    const impact = await fieldsDeleteImpact(uid, input.ids, tx);
    if (impact.impactHash !== input.impactHash) {
      throw new AppError("CONFLICT", "These fields changed since you reviewed the deletion. Review it again.");
    }
    const ids = [...new Set(input.ids)];
    const { count } = await tx.field.updateMany({ where: { id: { in: ids }, deletedAt: null }, data: { deletedAt: new Date() } });
    if (impact.clearsSequence) {
      await tx.template.update({ where: { id: templateId }, data: { sequenceFieldId: null } });
    }
    await markSourceChanged(tx, templateId);
    // Breaks the mappings that read these fields.
    await recomputeMappingStates(tx, templateId);
    const configState = await recomputeConfigState(tx, templateId);
    return { deleted: count, templateId, configState };
  });
  await requestTemplateTransform(templateId);
  return result;
}

export async function restoreField(
  userId: string,
  fieldId: string,
): Promise<{
  field: FieldView;
  sequenceRestored: boolean;
  mappingsRepaired: number;
  configState: ConfigState;
}> {
  const { templateId } = await requireFieldAccess(userId, fieldId, true);

  const result = await prisma.$transaction(async (tx) => {
    await lockTemplate(tx, templateId);
    const field = await tx.field.findFirst({ where: { id: fieldId, deletedAt: { not: null } }, select: fieldSelect });
    if (!field) throw new AppError("NOT_FOUND", "That field isn't in the deleted list any more. Reload the page.");
    const source = await loadSourceFields(tx, templateId);
    if (source.list.length >= MAX_FIELDS) throw new AppError("VALIDATION", `A template can have up to ${MAX_FIELDS} fields.`);

    // Back at its old place in the list, unless a field added since holds that exact key.
    let position = field.position;
    let rewrites: Positioned[] = [];
    const collider = source.list.find((f) => f.position === field.position);
    if (collider) {
      const placed = positionAfter(source.list, collider.id, fieldId);
      position = placed.position;
      rewrites = placed.rewrites;
    }
    await applyPositionRewrites(tx, rewrites);

    const template = await tx.template.findUniqueOrThrow({ where: { id: templateId }, select: { kind: true, sequenceFieldId: true } });
    const sequenceRestored =
      field.isSequence && template.kind === "TABLE" && template.sequenceFieldId === null && field.mode === "EXTRACT";
    if (sequenceRestored) {
      await tx.template.update({ where: { id: templateId }, data: { sequenceFieldId: fieldId } });
    }

    const restored = await tx.field.update({
      where: { id: fieldId },
      data: { deletedAt: null, position, isSequence: sequenceRestored },
      select: fieldSelect,
    });

    await markSourceChanged(tx, templateId);
    // Repair the mappings that work again: every input and the column live.
    const { repaired } = await recomputeMappingStates(tx, templateId);

    const configState = await recomputeConfigState(tx, templateId);
    return { field: toFieldView(restored), sequenceRestored, mappingsRepaired: repaired, configState };
  });
  await requestTemplateTransform(templateId);
  return result;
}
