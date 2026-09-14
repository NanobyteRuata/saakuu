import type { Prisma } from "@prisma/client";

import { markSymbolsSchema, type FieldMode, type FieldType, type MarkSymbols } from "./schemas";

export type GroupView = { id: string; label: string; position: string };

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
  isSequence: boolean;
  position: string;
};

export type DeletedFieldView = FieldView & { deletedAt: string };

export const groupSelect = { id: true, label: true, position: true } satisfies Prisma.FieldGroupSelect;

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
  isSequence: true,
  position: true,
} satisfies Prisma.FieldSelect;

type FieldRow = Prisma.FieldGetPayload<{ select: typeof fieldSelect }>;

export function toFieldView(row: FieldRow): FieldView {
  const marks = markSymbolsSchema.safeParse(row.markSymbols);
  return { ...row, markSymbols: marks.success ? marks.data : null };
}
