import { createId } from "@paralleldrive/cuid2";
import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db/client";
import { AppError } from "@/lib/errors";

import { impactHash } from "@/lib/impact";
import { recomputeMappingStates } from "@/lib/mappings/state";
import { requestTemplateTransform } from "@/lib/transform/triggers";

import { lockTemplate, markSourceChanged, recomputeConfigState, requireFieldAccess, requireGroupAccess, requireTemplateAccess, type Db } from "./access";
import { appendPosition, positionAfter } from "./positions";
import {
  fieldShapeProblem,
  MAX_FIELDS,
  MAX_GROUPS,
  type CreateFieldInput,
  type CreateGroupInput,
  type DeleteGroupInput,
  type FieldTypeOptions,
  type MarkSymbols,
  type UpdateFieldInput,
  type UpdateGroupInput,
} from "./schemas";
import { applySiblingRewrites, loadSourceTree, type SourceTree } from "./source-tree";
import {
  buildTree,
  childrenOf,
  groupPlacementProblem,
  introducedSelectionProblem,
  nearestSelectionGroup,
  planGroupDelete,
  toSibling,
  type Sibling,
} from "./tree";
import { fieldSelect, groupSelect, toFieldView, type FieldView, type GroupView } from "./views";

/**
 * Groups and fields: create, edit, move, delete a group. Every write locks the template row first,
 * then validates against the whole source tree (at most 100 groups and 500 fields, in memory).
 */

const GROUP_GONE = "That group was deleted. Reload and try again.";

function jsonOrNull(value: MarkSymbols | FieldTypeOptions | null): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return value === null ? Prisma.DbNull : value;
}

function assertParent(tree: SourceTree, groupId: string | null): void {
  if (groupId !== null && !tree.groups.has(groupId)) throw new AppError("VALIDATION", GROUP_GONE);
}

function siblingsUnder(tree: SourceTree, parentId: string | null): Sibling[] {
  return childrenOf(tree, parentId).map(toSibling);
}

// ---------- Groups ----------

export async function createGroup(userId: string, templateId: string, input: CreateGroupInput): Promise<GroupView> {
  await requireTemplateAccess(userId, templateId);
  return prisma.$transaction(async (tx) => {
    await lockTemplate(tx, templateId);
    const { groups, tree } = await loadSourceTree(tx, templateId);
    if (groups.length >= MAX_GROUPS) throw new AppError("VALIDATION", `A template can have up to ${MAX_GROUPS} groups.`);
    const parentGroupId = input.parentGroupId ?? null;
    const placement = groupPlacementProblem(tree, null, parentGroupId);
    if (placement) throw new AppError("VALIDATION", placement);

    const group: GroupView = {
      id: createId(),
      parentGroupId,
      labelSource: input.labelSource,
      labelMeaning: input.labelMeaning ?? null,
      position: appendPosition(siblingsUnder(tree, parentGroupId)),
      // An empty group can't be a selection group yet; selection is set later with PATCH.
      selection: "NONE",
      noneMarked: input.noneMarked ?? "REVIEW",
      multipleMarked: input.multipleMarked ?? "ERROR",
      note: input.note ?? null,
    };
    const created = await tx.fieldGroup.create({ data: { templateId, ...group }, select: groupSelect });
    await markSourceChanged(tx, templateId);
    return created;
  });
}

/** What about a group reaches rows. Its position counts only inside a tick group, where it orders the options. */
function groupOutputKey(g: GroupView, withPosition: boolean): string {
  return JSON.stringify([
    g.labelSource,
    g.labelMeaning,
    g.selection,
    g.noneMarked,
    g.multipleMarked,
    g.parentGroupId,
    withPosition ? g.position : null,
  ]);
}

/** What about a field reaches rows: everything but its note, and its position only as a tick-group option. */
function fieldOutputKey(f: FieldView, withPosition: boolean): string {
  return JSON.stringify([
    f.labelSource,
    f.labelMeaning,
    f.dataType,
    f.mode,
    f.choices,
    f.markSymbols,
    f.typeOptions,
    f.groupId,
    withPosition ? f.position : null,
  ]);
}

/** Edits a group's properties and/or moves it (`move`: new parent + sibling to follow). A move writes one row. */
export async function updateGroup(userId: string, groupId: string, input: UpdateGroupInput): Promise<GroupView> {
  const { templateId } = await requireGroupAccess(userId, groupId);
  const group = await prisma.$transaction(async (tx) => {
    await lockTemplate(tx, templateId);
    const { groups, fields, tree } = await loadSourceTree(tx, templateId);
    const current = tree.groups.get(groupId);
    if (!current) throw new AppError("NOT_FOUND", "That group doesn't exist or was already deleted.");

    const next: GroupView = { ...current.group };
    if (input.labelSource !== undefined) next.labelSource = input.labelSource;
    if (input.labelMeaning !== undefined) next.labelMeaning = input.labelMeaning;
    if (input.selection !== undefined) next.selection = input.selection;
    if (input.noneMarked !== undefined) next.noneMarked = input.noneMarked;
    if (input.multipleMarked !== undefined) next.multipleMarked = input.multipleMarked;
    if (input.note !== undefined) next.note = input.note;

    let rewrites: Sibling[] = [];
    if (input.move) {
      const { parentGroupId, after } = input.move;
      const placement = groupPlacementProblem(tree, groupId, parentGroupId);
      if (placement) throw new AppError("VALIDATION", placement);
      const placed = positionAfter(siblingsUnder(tree, parentGroupId), after, { kind: "group", id: groupId });
      next.parentGroupId = parentGroupId;
      next.position = placed.position;
      rewrites = placed.rewrites;
    }

    const afterTree = buildTree(
      groups.map((g) => (g.id === groupId ? next : g)),
      fields,
    );
    const problem = introducedSelectionProblem(tree, afterTree, { kind: "group", id: groupId });
    if (problem) throw new AppError("VALIDATION", problem);

    await applySiblingRewrites(tx, rewrites);
    const updated = await tx.fieldGroup.update({
      where: { id: groupId },
      data: {
        parentGroupId: next.parentGroupId,
        labelSource: next.labelSource,
        labelMeaning: next.labelMeaning,
        position: next.position,
        selection: next.selection,
        noneMarked: next.noneMarked,
        multipleMarked: next.multipleMarked,
        note: next.note,
      },
      select: groupSelect,
    });
    await markSourceChanged(tx, templateId);
    const ordered = [tree, afterTree].some((t) => nearestSelectionGroup(t, next.parentGroupId) !== undefined);
    const affectsRows = groupOutputKey(next, ordered) !== groupOutputKey(current.group, ordered);
    if (affectsRows) {
      // Selection settings, labels and nesting change tick-group answers and whether mappings work.
      await recomputeMappingStates(tx, templateId);
      await recomputeConfigState(tx, templateId);
    }
    return { updated, affectsRows };
  });
  // A note is only for the AI: saving one doesn't rebuild rows.
  if (group.affectsRows) await requestTemplateTransform(templateId);
  return group.updated;
}

export type GroupDeleteImpact = {
  /** Covers the counts and which children move; the delete is refused if it changed since the preview. */
  impactHash: string;
  groupLabel: string;
  /** Live fields directly in the group; they move up into its slot. */
  fields: number;
  /** Sub-groups directly in the group; they move up too, with everything inside them. */
  groups: number;
  /** Soft-deleted fields last in this group; a restore puts them in the group's parent. */
  deletedFields: number;
  /** Where the children go; null = the top level of the template. */
  parentLabel: string | null;
  /** Mappings that read this group as a tick group; they break. */
  brokenMappings: number;
};

async function computeGroupDeleteImpact(db: Db, tree: SourceTree, templateId: string, groupId: string): Promise<GroupDeleteImpact> {
  const node = tree.groups.get(groupId);
  if (!node) throw new AppError("NOT_FOUND", "That group doesn't exist or was already deleted.");
  const deletedFields = await db.field.count({ where: { templateId, groupId, deletedAt: { not: null } } });
  const brokenMappings = await db.mapping.count({ where: { templateId, inputs: { some: { groupId } } } });
  const parent = node.parentId === null ? undefined : tree.groups.get(node.parentId);
  const body = {
    groupLabel: node.group.labelSource,
    fields: node.children.filter((c) => c.kind === "field").length,
    groups: node.children.filter((c) => c.kind === "group").length,
    deletedFields,
    parentLabel: parent?.group.labelSource ?? null,
    brokenMappings,
  };
  const children = node.children.map((c) => `${c.kind}:${c.id}`);
  return { impactHash: impactHash({ action: "groups.delete", groupId, parentId: node.parentId, children, ...body }), ...body };
}

export async function groupDeleteImpact(userId: string, groupId: string): Promise<GroupDeleteImpact> {
  const { templateId } = await requireGroupAccess(userId, groupId);
  const { tree } = await loadSourceTree(prisma, templateId);
  return computeGroupDeleteImpact(prisma, tree, templateId, groupId);
}

/**
 * Deletes a group (docs/02 invariant 12). Its child groups and live fields move up one level into
 * its slot, in order; its soft-deleted fields are re-parented to its parent. No field is deleted.
 */
export async function deleteGroup(
  userId: string,
  groupId: string,
  input: DeleteGroupInput,
): Promise<{ movedFields: number; movedGroups: number }> {
  const { templateId } = await requireGroupAccess(userId, groupId);
  const result = await prisma.$transaction(async (tx) => {
    await lockTemplate(tx, templateId);
    const { tree } = await loadSourceTree(tx, templateId);
    const impact = await computeGroupDeleteImpact(tx, tree, templateId, groupId);
    if (impact.impactHash !== input.impactHash) {
      throw new AppError("CONFLICT", "This group changed since you reviewed the deletion. Review it again.");
    }
    const plan = planGroupDelete(tree, groupId);
    if (!plan) throw new AppError("NOT_FOUND", "That group doesn't exist or was already deleted.");

    for (const w of plan.writes) {
      if (w.kind === "field") await tx.field.update({ where: { id: w.id }, data: { groupId: w.parentId, position: w.position } });
      else await tx.fieldGroup.update({ where: { id: w.id }, data: { parentGroupId: w.parentId, position: w.position } });
    }
    await tx.field.updateMany({ where: { templateId, groupId, deletedAt: { not: null } }, data: { groupId: plan.parentId } });
    // parentGroupId is ON DELETE RESTRICT: this fails rather than lose a sub-group that wasn't moved.
    await tx.fieldGroup.delete({ where: { id: groupId } });
    await markSourceChanged(tx, templateId);
    // Mapping inputs on the group were set to null by the delete: those mappings are now broken.
    await recomputeMappingStates(tx, templateId);
    await recomputeConfigState(tx, templateId);
    return { movedFields: plan.movedFields, movedGroups: plan.movedGroups };
  });
  await requestTemplateTransform(templateId);
  return result;
}

// ---------- Fields ----------

export async function createField(userId: string, templateId: string, input: CreateFieldInput): Promise<FieldView> {
  await requireTemplateAccess(userId, templateId);
  const { field, repaired } = await prisma.$transaction(async (tx) => {
    await lockTemplate(tx, templateId);
    const { groups, fields, tree } = await loadSourceTree(tx, templateId);
    if (fields.length >= MAX_FIELDS) throw new AppError("VALIDATION", `A template can have up to ${MAX_FIELDS} fields.`);
    const groupId = input.groupId ?? null;
    assertParent(tree, groupId);

    const dataType = input.dataType ?? (nearestSelectionGroup(tree, groupId) ? "MARK" : "TEXT");
    const markSymbols = input.markSymbols ?? null;
    const typeOptions = input.typeOptions ?? null;
    const shape = fieldShapeProblem({ dataType, choices: input.choices, markSymbols, typeOptions });
    if (shape) throw new AppError("VALIDATION", shape);

    const draft: FieldView = {
      id: createId(),
      groupId,
      labelSource: input.labelSource,
      labelMeaning: input.labelMeaning ?? null,
      dataType,
      mode: input.mode,
      note: input.note ?? null,
      choices: input.choices,
      markSymbols,
      typeOptions,
      isSequence: false,
      position: appendPosition(siblingsUnder(tree, groupId)),
    };
    const problem = introducedSelectionProblem(tree, buildTree(groups, [...fields, draft]), { kind: "field", id: draft.id });
    if (problem) throw new AppError("VALIDATION", problem);

    const field = await tx.field.create({
      data: { ...draft, templateId, markSymbols: jsonOrNull(markSymbols), typeOptions: jsonOrNull(typeOptions) },
      select: fieldSelect,
    });
    await markSourceChanged(tx, templateId);
    // A new option can repair a tick group's mapping.
    const { repaired } = await recomputeMappingStates(tx, templateId);
    await recomputeConfigState(tx, templateId);
    return { field: toFieldView(field), repaired };
  });
  if (repaired > 0) await requestTemplateTransform(templateId);
  return field;
}

export async function updateField(userId: string, fieldId: string, input: UpdateFieldInput): Promise<FieldView> {
  const { templateId } = await requireFieldAccess(userId, fieldId, false);
  const field = await prisma.$transaction(async (tx) => {
    await lockTemplate(tx, templateId);
    const { groups, fields, tree } = await loadSourceTree(tx, templateId);
    const current = tree.fields.get(fieldId)?.field;
    if (!current) throw new AppError("NOT_FOUND", "That field doesn't exist or was deleted.");
    const template = await tx.template.findUniqueOrThrow({ where: { id: templateId }, select: { sequenceFieldId: true } });

    const dataType = input.dataType ?? current.dataType;
    const mode = input.mode ?? current.mode;
    // A type change drops properties that no longer apply rather than failing on them.
    const choices = input.choices ?? (dataType === "CHOICE" ? current.choices : []);
    const markSymbols = input.markSymbols !== undefined ? input.markSymbols : dataType === "MARK" ? current.markSymbols : null;
    const typeOptions = input.typeOptions !== undefined ? input.typeOptions : dataType === "DATE" ? current.typeOptions : null;
    const shape = fieldShapeProblem({ dataType, choices, markSymbols, typeOptions });
    if (shape) throw new AppError("VALIDATION", shape);
    if (template.sequenceFieldId === fieldId && mode !== "EXTRACT") {
      throw new AppError(
        "VALIDATION",
        "This is the table's sequence field, so the AI has to read it. Choose a different sequence field first.",
      );
    }

    const next: FieldView = { ...current, dataType, mode, choices, markSymbols, typeOptions };
    if (input.labelSource !== undefined) next.labelSource = input.labelSource;
    if (input.labelMeaning !== undefined) next.labelMeaning = input.labelMeaning;
    if (input.note !== undefined) next.note = input.note;

    let rewrites: Sibling[] = [];
    if (input.move) {
      const { groupId, after } = input.move;
      assertParent(tree, groupId);
      const placed = positionAfter(siblingsUnder(tree, groupId), after, { kind: "field", id: fieldId });
      next.groupId = groupId;
      next.position = placed.position;
      rewrites = placed.rewrites;
    }

    const afterTree = buildTree(
      groups,
      fields.map((f) => (f.id === fieldId ? next : f)),
    );
    const problem = introducedSelectionProblem(tree, afterTree, { kind: "field", id: fieldId });
    if (problem) throw new AppError("VALIDATION", problem);

    await applySiblingRewrites(tx, rewrites);
    const updated = await tx.field.update({
      where: { id: fieldId },
      data: {
        labelSource: next.labelSource,
        labelMeaning: next.labelMeaning,
        note: next.note,
        dataType,
        mode,
        choices,
        markSymbols: jsonOrNull(markSymbols),
        typeOptions: jsonOrNull(typeOptions),
        groupId: next.groupId,
        position: next.position,
      },
      select: fieldSelect,
    });
    await markSourceChanged(tx, templateId);
    const ordered =
      (current.dataType === "MARK" && nearestSelectionGroup(tree, current.groupId) !== undefined) ||
      (next.dataType === "MARK" && nearestSelectionGroup(afterTree, next.groupId) !== undefined);
    const affectsRows = fieldOutputKey(next, ordered) !== fieldOutputKey(current, ordered);
    if (affectsRows) {
      // Type, mode, symbols, choices, labels and placement change how values normalise, map and resolve.
      await recomputeMappingStates(tx, templateId);
      await recomputeConfigState(tx, templateId);
    }
    return { updated: toFieldView(updated), affectsRows };
  });
  // A note is only for the AI: saving one doesn't rebuild rows.
  if (field.affectsRows) await requestTemplateTransform(templateId);
  return field.updated;
}
