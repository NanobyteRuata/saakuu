import type { Prisma } from "@prisma/client";

import {
  fieldTypeOptionsSchema,
  markSymbolsSchema,
  type FieldMode,
  type FieldType,
  type FieldTypeOptions,
  type GroupSelection,
  type MarkSymbols,
  type MultipleMarked,
  type NoneMarked,
} from "./schemas";

export type GroupView = {
  id: string;
  parentGroupId: string | null;
  labelSource: string;
  labelMeaning: string | null;
  position: string;
  selection: GroupSelection;
  noneMarked: NoneMarked;
  multipleMarked: MultipleMarked;
  note: string | null;
};

export type FieldView = {
  id: string;
  groupId: string | null;
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

export const groupSelect = {
  id: true,
  parentGroupId: true,
  labelSource: true,
  labelMeaning: true,
  position: true,
  selection: true,
  noneMarked: true,
  multipleMarked: true,
  note: true,
} satisfies Prisma.FieldGroupSelect;

export const fieldSelect = {
  id: true,
  groupId: true,
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
