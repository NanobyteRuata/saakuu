import type { Prisma } from "@prisma/client";
import { z } from "zod";

import type { MappingSource, TransformMapping } from "@/lib/transform/types";

import type { MappingDraft, MappingSourceInput } from "./schemas";

/** Mapping rows as the API returns them, and the conversions to the transform's shape. */

export type MappingSourceView = MappingSourceInput | { kind: "missing" };

export type MappingView = Omit<MappingDraft, "inputs"> & {
  id: string;
  state: "OK" | "BROKEN";
  /** Why it is broken, in plain language; null when it works. Worked out on read. */
  problem: string | null;
  position: string;
  inputs: MappingSourceView[];
};

export const mappingSelect = {
  id: true,
  outputColumnId: true,
  kind: true,
  state: true,
  separator: true,
  splitBy: true,
  splitIndex: true,
  splitRegex: true,
  constantValue: true,
  expression: true,
  fillDown: true,
  position: true,
  inputs: {
    select: { fieldId: true, groupId: true, position: true, optionValues: true, noneValue: true },
    orderBy: [{ position: "asc" }, { id: "asc" }],
  },
} satisfies Prisma.MappingSelect;

export type MappingRow = Prisma.MappingGetPayload<{ select: typeof mappingSelect }>;

const optionValuesSchema = z.record(z.string(), z.string());

export function toSourceView(input: MappingRow["inputs"][number]): MappingSourceView {
  if (input.fieldId !== null) return { kind: "field", id: input.fieldId };
  if (input.groupId === null) return { kind: "missing" };
  const parsed = optionValuesSchema.safeParse(input.optionValues);
  return { kind: "group", id: input.groupId, optionValues: parsed.success ? parsed.data : {}, noneValue: input.noneValue };
}

export function toTransformSource(source: MappingSourceView): MappingSource {
  if (source.kind === "field") return { kind: "field", fieldId: source.id };
  if (source.kind === "group") return { kind: "group", groupId: source.id, optionValues: source.optionValues, noneValue: source.noneValue };
  return { kind: "missing" };
}

export function toTransformMapping(row: Omit<MappingRow, "inputs"> & { inputs: MappingSourceView[] }): TransformMapping {
  return {
    id: row.id,
    outputColumnId: row.outputColumnId,
    kind: row.kind,
    separator: row.separator,
    splitBy: row.splitBy,
    splitIndex: row.splitIndex,
    splitRegex: row.splitRegex,
    constantValue: row.constantValue,
    expression: row.expression,
    fillDown: row.fillDown,
    inputs: row.inputs.map(toTransformSource),
  };
}

export function rowToTransformMapping(row: MappingRow): TransformMapping {
  return toTransformMapping({ ...row, inputs: row.inputs.map(toSourceView) });
}
