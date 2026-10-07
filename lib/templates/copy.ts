import { createId } from "@paralleldrive/cuid2";
import { Prisma } from "@prisma/client";

import { MAX_MAPPINGS } from "@/lib/mappings/schemas";
import { recomputeMappingStates } from "@/lib/mappings/state";
import { expressionFromDisplay } from "@/lib/transform/expression";

import { recomputeConfigState, type Db } from "./access";
import { appendPosition } from "./positions";
import { MAX_FIELDS, type TemplateKind } from "./schemas";
import { fieldSelect } from "./views";

/**
 * How a copy's mappings find their output columns (decision 3: the source layer is portable, the mapping
 * layer is book-bound).
 * - `"same"`: the copy stays in its book, so each mapping keeps its column.
 * - a map: the book's columns were copied too (a new book from a book); each mapping follows its column
 *   to the copy, and one whose column did not travel is skipped.
 * - `null`: the copy goes to another book whose columns it knows nothing about. No mapping is read or
 *   written; `Create columns from this template` in that book finishes the job.
 */
export type ColumnMap = "same" | ReadonlyMap<string, string> | null;

export type TemplateCopy = { id: string; fields: number; mappings: number; skippedMappings: number };

export async function nextTemplatePosition(db: Db, bookId: string): Promise<string> {
  const existing = await db.template.findMany({ where: { bookId }, select: { id: true, position: true }, take: 5000 });
  return appendPosition(existing);
}

/**
 * Copies a template's live source layer (fields, notes, anchors, language hint,
 * instructions) with new ids into `targetBookId`, and its mappings as `columnMap` says. The caller has
 * checked ownership of both books and holds the target book's lock.
 */
export async function copyTemplateInto(
  tx: Db,
  input: {
    sourceTemplateId: string;
    targetBookId: string;
    name: string;
    kind?: TemplateKind;
    columnMap: ColumnMap;
    /**
     * Templates list in creation order, and the column default is the transaction's start time, so copies
     * made in one transaction must be told apart explicitly or they come out in id order.
     */
    createdAt?: Date;
  },
): Promise<TemplateCopy> {
  const { sourceTemplateId: templateId, targetBookId, columnMap } = input;
  const source = await tx.template.findUniqueOrThrow({
    where: { id: templateId },
    select: { kind: true, modelOverride: true, anchors: true, languageHint: true, instructions: true, sequenceFieldId: true },
  });
  const fields = await tx.field.findMany({ where: { templateId, deletedAt: null }, select: fieldSelect, take: MAX_FIELDS });
  const kind = input.kind ?? source.kind;

  const newTemplateId = createId();
  const fieldIds = new Map(fields.map((f) => [f.id, createId()]));
  const sequenceFieldId = kind === "TABLE" && source.sequenceFieldId ? (fieldIds.get(source.sequenceFieldId) ?? null) : null;

  await tx.template.create({
    data: {
      id: newTemplateId,
      bookId: targetBookId,
      name: input.name,
      kind,
      modelOverride: source.modelOverride,
      anchors: source.anchors,
      languageHint: source.languageHint,
      instructions: source.instructions,
      sequenceFieldId,
      position: await nextTemplatePosition(tx, targetBookId),
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    },
  });
  await tx.field.createMany({
    data: fields.map((f) => {
      const id = fieldIds.get(f.id) ?? createId();
      return {
        id,
        templateId: newTemplateId,
        labelSource: f.labelSource,
        labelMeaning: f.labelMeaning,
        dataType: f.dataType,
        mode: f.mode,
        note: f.note,
        choices: f.choices,
        markSymbols: f.markSymbols === null ? Prisma.DbNull : f.markSymbols,
        typeOptions: f.typeOptions === null ? Prisma.DbNull : f.typeOptions,
        isSequence: id === sequenceFieldId,
        position: f.position,
      };
    }),
  });

  let mappingCount = 0;
  let skippedMappings = 0;
  if (columnMap !== null) {
    const mappings = await tx.mapping.findMany({
      where: { templateId },
      include: {
        inputs: { select: { fieldId: true, position: true, tickValue: true } },
        outputColumn: { select: { deletedAt: true } },
      },
      take: MAX_MAPPINGS,
    });
    for (const m of mappings) {
      // Inputs point at the copies of the fields they read.
      const inputs = m.inputs.flatMap((i) => {
        const fieldId = fieldIds.get(i.fieldId);
        return fieldId === undefined ? [] : [{ fieldId, position: i.position, tickValue: i.tickValue }];
      });
      const gone = inputs.length !== m.inputs.length;
      const outputColumnId = columnMap === "same" ? m.outputColumnId : columnMap.get(m.outputColumnId);
      if (m.outputColumn.deletedAt !== null || gone || outputColumnId === undefined) {
        skippedMappings++;
        continue;
      }
      const mappingId = createId();
      await tx.mapping.create({
        data: {
          id: mappingId,
          templateId: newTemplateId,
          outputColumnId,
          kind: m.kind,
          state: "OK",
          separator: m.separator,
          splitBy: m.splitBy,
          splitIndex: m.splitIndex,
          splitRegex: m.splitRegex,
          constantValue: m.constantValue,
          expression: m.expression === null ? null : expressionFromDisplay(m.expression, (ref) => fieldIds.get(ref) ?? null),
          tickSelection: m.tickSelection,
          noneMarked: m.noneMarked,
          multipleMarked: m.multipleMarked,
          noneValue: m.noneValue,
          tickLabel: m.tickLabel,
          fillDown: m.fillDown,
          position: m.position,
        },
      });
      await tx.mappingInput.createMany({
        data: inputs.map((i) => ({ mappingId, ...i })),
      });
      mappingCount++;
    }
  }

  // A copy as the other kind can change what works (e.g. no sequence field); check every mapping.
  await recomputeMappingStates(tx, newTemplateId);
  await recomputeConfigState(tx, newTemplateId);
  return { id: newTemplateId, fields: fields.length, mappings: mappingCount, skippedMappings };
}
