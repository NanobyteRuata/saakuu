import { Prisma } from "@prisma/client";
import { generateNKeysBetween } from "fractional-indexing";

import { sortByPosition } from "@/lib/books/column-ops";
import { prisma } from "@/lib/db/client";
import { AppError } from "@/lib/errors";

import { lockTemplate, recomputeConfigState, requireFieldAccess, requireGroupAccess, requireTemplateAccess, type Db } from "./access";
import { appendPosition, positionAfter } from "./positions";
import {
  fieldShapeProblem,
  MAX_FIELDS,
  MAX_GROUPS,
  type CreateFieldInput,
  type MarkSymbols,
  type UpdateFieldInput,
  type UpdateGroupInput,
} from "./schemas";
import { fieldSelect, groupSelect, toFieldView, type FieldView, type GroupView } from "./views";

/** Groups and fields: create, edit, reorder. Every write locks the template row first. */

async function liveSiblings(tx: Db, templateId: string, groupId: string | null) {
  return tx.field.findMany({
    where: { templateId, groupId, deletedAt: null },
    select: { id: true, position: true },
    take: MAX_FIELDS,
  });
}

async function assertGroupInTemplate(tx: Db, templateId: string, groupId: string | null): Promise<void> {
  if (groupId === null) return;
  const group = await tx.fieldGroup.findFirst({ where: { id: groupId, templateId }, select: { id: true } });
  if (!group) throw new AppError("VALIDATION", "That group was deleted. Reload and try again.");
}

async function applyRewrites(tx: Db, model: "field" | "fieldGroup", rewrites: { id: string; position: string }[]) {
  for (const { id, position } of rewrites) {
    if (model === "field") await tx.field.update({ where: { id }, data: { position } });
    else await tx.fieldGroup.update({ where: { id }, data: { position } });
  }
}

function jsonOrNull(value: MarkSymbols | null): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return value === null ? Prisma.DbNull : value;
}

// ---------- Groups ----------

export async function createGroup(userId: string, templateId: string, label: string): Promise<GroupView> {
  await requireTemplateAccess(userId, templateId);
  return prisma.$transaction(async (tx) => {
    await lockTemplate(tx, templateId);
    const groups = await tx.fieldGroup.findMany({ where: { templateId }, select: { id: true, position: true }, take: MAX_GROUPS });
    if (groups.length >= MAX_GROUPS) throw new AppError("VALIDATION", `A template can have up to ${MAX_GROUPS} groups.`);
    return tx.fieldGroup.create({ data: { templateId, label, position: appendPosition(groups) }, select: groupSelect });
  });
}

export async function updateGroup(userId: string, groupId: string, input: UpdateGroupInput): Promise<GroupView> {
  const { templateId } = await requireGroupAccess(userId, groupId);
  return prisma.$transaction(async (tx) => {
    await lockTemplate(tx, templateId);
    const data: Prisma.FieldGroupUpdateInput = {};
    if (input.label !== undefined) data.label = input.label;
    if (input.afterId !== undefined) {
      const groups = await tx.fieldGroup.findMany({ where: { templateId }, select: { id: true, position: true }, take: MAX_GROUPS });
      const { position, rewrites } = positionAfter(groups, input.afterId, groupId);
      await applyRewrites(tx, "fieldGroup", rewrites);
      data.position = position;
    }
    return tx.fieldGroup.update({ where: { id: groupId }, data, select: groupSelect });
  });
}

/** Deletes a group. Its live fields move to Ungrouped, after the fields already there, in their order. */
export async function deleteGroup(userId: string, groupId: string): Promise<{ movedFields: number }> {
  const { templateId } = await requireGroupAccess(userId, groupId);
  return prisma.$transaction(async (tx) => {
    await lockTemplate(tx, templateId);
    const moving = sortByPosition(await liveSiblings(tx, templateId, groupId));
    if (moving.length > 0) {
      const ungrouped = await liveSiblings(tx, templateId, null);
      const last = sortByPosition(ungrouped).at(-1)?.position ?? null;
      const keys = generateNKeysBetween(last, null, moving.length);
      for (const [i, field] of moving.entries()) {
        await tx.field.update({ where: { id: field.id }, data: { groupId: null, position: keys[i] ?? field.position } });
      }
    }
    // Soft-deleted fields in the group fall back to Ungrouped through the FK's ON DELETE SET NULL.
    await tx.fieldGroup.delete({ where: { id: groupId } });
    return { movedFields: moving.length };
  });
}

// ---------- Fields ----------

export async function createField(userId: string, templateId: string, input: CreateFieldInput): Promise<FieldView> {
  await requireTemplateAccess(userId, templateId);
  return prisma.$transaction(async (tx) => {
    await lockTemplate(tx, templateId);
    const liveCount = await tx.field.count({ where: { templateId, deletedAt: null } });
    if (liveCount >= MAX_FIELDS) throw new AppError("VALIDATION", `A template can have up to ${MAX_FIELDS} fields.`);
    const groupId = input.groupId ?? null;
    await assertGroupInTemplate(tx, templateId, groupId);
    const field = await tx.field.create({
      data: {
        templateId,
        groupId,
        labelSource: input.labelSource,
        labelMeaning: input.labelMeaning ?? null,
        dataType: input.dataType,
        mode: input.mode,
        note: input.note ?? null,
        choices: input.choices,
        markSymbols: jsonOrNull(input.markSymbols ?? null),
        position: appendPosition(await liveSiblings(tx, templateId, groupId)),
      },
      select: fieldSelect,
    });
    await recomputeConfigState(tx, templateId);
    return toFieldView(field);
  });
}

export async function updateField(userId: string, fieldId: string, input: UpdateFieldInput): Promise<FieldView> {
  const { templateId } = await requireFieldAccess(userId, fieldId, false);
  return prisma.$transaction(async (tx) => {
    await lockTemplate(tx, templateId);
    const current = toFieldView(await tx.field.findUniqueOrThrow({ where: { id: fieldId }, select: fieldSelect }));
    const template = await tx.template.findUniqueOrThrow({ where: { id: templateId }, select: { sequenceFieldId: true } });

    const dataType = input.dataType ?? current.dataType;
    const mode = input.mode ?? current.mode;
    // A type change drops properties that no longer apply rather than failing on them.
    const choices = input.choices ?? (dataType === "CHOICE" ? current.choices : []);
    const markSymbols = input.markSymbols !== undefined ? input.markSymbols : dataType === "MARK" ? current.markSymbols : null;
    const problem = fieldShapeProblem({ dataType, choices, markSymbols });
    if (problem) throw new AppError("VALIDATION", problem);
    if (template.sequenceFieldId === fieldId && mode !== "EXTRACT") {
      throw new AppError(
        "VALIDATION",
        "This is the table's sequence field, so the AI has to read it. Choose a different sequence field first.",
      );
    }

    const data: Prisma.FieldUncheckedUpdateInput = { dataType, mode, choices, markSymbols: jsonOrNull(markSymbols) };
    if (input.labelSource !== undefined) data.labelSource = input.labelSource;
    if (input.labelMeaning !== undefined) data.labelMeaning = input.labelMeaning;
    if (input.note !== undefined) data.note = input.note;

    if (input.move) {
      const { groupId, afterId } = input.move;
      await assertGroupInTemplate(tx, templateId, groupId);
      const siblings = await liveSiblings(tx, templateId, groupId);
      if (afterId !== null && !siblings.some((s) => s.id === afterId)) {
        throw new AppError("VALIDATION", "The field you placed this next to has moved. Reload and try again.");
      }
      const { position, rewrites } = positionAfter(siblings, afterId, fieldId);
      await applyRewrites(tx, "field", rewrites);
      data.groupId = groupId;
      data.position = position;
    }

    const updated = await tx.field.update({ where: { id: fieldId }, data, select: fieldSelect });
    await tx.template.update({ where: { id: templateId }, data: { updatedAt: new Date() } });
    return toFieldView(updated);
  });
}
