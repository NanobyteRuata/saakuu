import type { Prisma } from "@prisma/client";

import {
  fieldTypeOptionsSchema,
  markSymbolsSchema,
  type FieldMode,
  type FieldType,
  type FieldTypeOptions,
  type MarkSymbols,
} from "./schemas";

export type FieldView = {
  id: string;
  /** Its name: as written on the paper, with the header above it in front ("RDT Test › Positive › A"). */
  labelSource: string;
  labelMeaning: string | null;
  dataType: FieldType;
  mode: FieldMode;
  note: string | null;
  choices: string[];
  markSymbols: MarkSymbols | null;
  /** Settings for this field's type, e.g. how a date field reads two-digit years. */
  typeOptions: FieldTypeOptions | null;
  isSequence: boolean;
  position: string;
};

export type DeletedFieldView = FieldView & { deletedAt: string };

export const fieldSelect = {
  id: true,
  labelSource: true,
  labelMeaning: true,
  dataType: true,
  mode: true,
  note: true,
  choices: true,
  markSymbols: true,
  typeOptions: true,
  isSequence: true,
  position: true,
} satisfies Prisma.FieldSelect;

type FieldRow = Prisma.FieldGetPayload<{ select: typeof fieldSelect }>;

export function toFieldView(row: FieldRow): FieldView {
  const marks = markSymbolsSchema.safeParse(row.markSymbols);
  const options = fieldTypeOptionsSchema.safeParse(row.typeOptions);
  return { ...row, markSymbols: marks.success ? marks.data : null, typeOptions: options.success ? options.data : null };
}
