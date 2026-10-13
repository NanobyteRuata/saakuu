import type { Prisma } from "@prisma/client";

import { DEFAULT_TICK_RULES } from "@/lib/transform/mappings";
import type { MappingSource, TickRules, TransformMapping } from "@/lib/transform/types";

import { parseReadAs, type ReadAs } from "./read-as";
import type { MappingDraft, MappingSourceInput } from "./schemas";

/** Mapping rows as the API returns them, and the conversions to the transform's shape. */

/** A source as stored: its Read as is always there. */
export type MappingSourceView = MappingSourceInput & { readAs: ReadAs };

export type MappingView = Omit<MappingDraft, "inputs"> & {
  inputs: MappingSourceView[];
  id: string;
  state: "OK" | "BROKEN";
  /** Why it is broken, in plain language; null when it works. Worked out on read. */
  problem: string | null;
  position: string;
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
  tickSelection: true,
  noneMarked: true,
  multipleMarked: true,
  noneValue: true,
  tickLabel: true,
  fillDown: true,
  position: true,
  inputs: {
    select: { fieldId: true, position: true, tickValue: true, readAs: true },
    orderBy: [{ position: "asc" }, { id: "asc" }],
  },
} satisfies Prisma.MappingSelect;

export type MappingRow = Prisma.MappingGetPayload<{ select: typeof mappingSelect }>;

export function toSourceView(input: MappingRow["inputs"][number]): MappingSourceView {
  return { id: input.fieldId, tickValue: input.tickValue, readAs: parseReadAs(input.readAs) };
}

export function toTransformSource(source: MappingSourceView): MappingSource {
  return { fieldId: source.id, tickValue: source.tickValue, readAs: source.readAs };
}

type TickColumns = Pick<MappingRow, "kind" | "tickSelection" | "noneMarked" | "multipleMarked" | "noneValue" | "tickLabel">;

/** The tick rules a row stores, for a From ticks mapping; null for every other kind. */
export function rowTickRules(row: TickColumns): TickRules | null {
  if (row.kind !== "TICKS") return null;
  return {
    selection: row.tickSelection ?? DEFAULT_TICK_RULES.selection,
    noneMarked: row.noneMarked ?? DEFAULT_TICK_RULES.noneMarked,
    multipleMarked: row.multipleMarked ?? DEFAULT_TICK_RULES.multipleMarked,
    noneValue: row.noneValue,
    label: row.tickLabel,
  };
}

export function rowToTransformMapping(row: MappingRow): TransformMapping {
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
    ticks: rowTickRules(row),
    fillDown: row.fillDown,
    inputs: row.inputs.map((i) => toTransformSource(toSourceView(i))),
  };
}
