import { createId } from "@paralleldrive/cuid2";
import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db/client";
import { AppError } from "@/lib/errors";

import { recomputeMappingStates } from "@/lib/mappings/state";
import { requestTemplateTransform } from "@/lib/transform/triggers";

import { lockTemplate, markSourceChanged, recomputeConfigState, requireFieldAccess, requireTemplateAccess } from "./access";
import { appendPosition, positionAfter, type Positioned } from "./positions";
import { fieldShapeProblem, MAX_FIELDS, type CreateFieldInput, type FieldTypeOptions, type MarkSymbols, type UpdateFieldInput } from "./schemas";
import { applyPositionRewrites, loadSourceFields } from "./source-fields";
import { fieldSelect, toFieldView, type FieldView } from "./views";

/**
 * Fields: create, edit, move. Every write locks the template row first, then validates against the
 * whole list (at most 500 fields, in memory). Two fields may share a name: the editor warns, nothing
 * here refuses (decision 84).
 */

function jsonOrNull(value: MarkSymbols | FieldTypeOptions | null): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return value === null ? Prisma.DbNull : value;
}

export async function createField(userId: string, templateId: string, input: CreateFieldInput): Promise<FieldView> {
  await requireTemplateAccess(userId, templateId);
  return prisma.$transaction(async (tx) => {
    await lockTemplate(tx, templateId);
    const source = await loadSourceFields(tx, templateId);
    if (source.list.length >= MAX_FIELDS) throw new AppError("VALIDATION", `A template can have up to ${MAX_FIELDS} fields.`);

    const dataType = input.dataType ?? "TEXT";
    const markSymbols = input.markSymbols ?? null;
    const typeOptions = input.typeOptions ?? null;
    const shape = fieldShapeProblem({ dataType, choices: input.choices, markSymbols, typeOptions });
    if (shape) throw new AppError("VALIDATION", shape);

    const id = createId();
    const placed = input.after === undefined ? { position: appendPosition(source.list), rewrites: [] as Positioned[] } : positionAfter(source.list, input.after, id);
    const draft: FieldView = {
      id,
      labelSource: input.labelSource,
      labelMeaning: input.labelMeaning ?? null,
      dataType,
      mode: input.mode,
      note: input.note ?? null,
      choices: input.choices,
      markSymbols,
      typeOptions,
      isSequence: false,
      position: placed.position,
    };

    await applyPositionRewrites(tx, placed.rewrites);
    const field = await tx.field.create({
      data: { ...draft, templateId, markSymbols: jsonOrNull(markSymbols), typeOptions: jsonOrNull(typeOptions) },
      select: fieldSelect,
    });
    await markSourceChanged(tx, templateId);
    // No mapping reads a field that has only just been made, so mapping states can't have changed.
    await recomputeConfigState(tx, templateId);
    return toFieldView(field);
  });
}

/** What about a field reaches rows: everything but its note and its place in the list. */
function fieldOutputKey(f: FieldView): string {
  return JSON.stringify([f.labelSource, f.labelMeaning, f.dataType, f.mode, f.choices, f.markSymbols, f.typeOptions]);
}

export async function updateField(userId: string, fieldId: string, input: UpdateFieldInput): Promise<FieldView> {
  const { templateId } = await requireFieldAccess(userId, fieldId, false);
  const field = await prisma.$transaction(async (tx) => {
    await lockTemplate(tx, templateId);
    const source = await loadSourceFields(tx, templateId);
    const current = source.byId.get(fieldId);
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

    let rewrites: Positioned[] = [];
    if (input.move) {
      const placed = positionAfter(source.list, input.move.after, fieldId);
      next.position = placed.position;
      rewrites = placed.rewrites;
    }

    await applyPositionRewrites(tx, rewrites);
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
        position: next.position,
      },
      select: fieldSelect,
    });
    await markSourceChanged(tx, templateId);
    const affectsRows = fieldOutputKey(next) !== fieldOutputKey(current);
    if (affectsRows) {
      // Type, mode, symbols, choices and the name change how values normalise and map, and whether a
      // From ticks mapping can still read the field.
      await recomputeMappingStates(tx, templateId);
      await recomputeConfigState(tx, templateId);
    }
    return { updated: toFieldView(updated), affectsRows };
  });
  // A note is only for the AI, and a move only for the order it reads in: neither rebuilds rows.
  if (field.affectsRows) await requestTemplateTransform(templateId);
  return field.updated;
}
