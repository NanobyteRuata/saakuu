import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { planMerge, type CellValues, type ExistingRow } from "./merge";
import { runTransform } from "./run";
import type {
  BookSettings,
  ComputedCell,
  MappingKind,
  RowType,
  TickRules,
  TransformColumn,
  TransformField,
  TransformInput,
  ValueState,
} from "./types";

/**
 * Golden files for the transform (docs/03 §11): raw records in, rows out. Each file in `golden/` holds
 * a compact input, the expected rows and flags and, when it lists existing rows, the expected merge.
 * Cells are shown as their value when plain; otherwise only what differs from a plain cell.
 */

type FixtureValue = string | null | { text?: string | null; state?: ValueState; ditto?: boolean; confidence?: number };

type Fixture = {
  description: string;
  input: {
    kind: "FORM" | "TABLE";
    sequenceFieldId?: string;
    book?: Partial<BookSettings>;
    manualValues?: Record<string, string>;
    fields: (Partial<TransformField> & { id: string })[];
    columns: (Partial<TransformColumn> & { key: string })[];
    mappings: {
      column: string;
      kind?: MappingKind;
      /** A field id, or for TICKS a field with the value its tick writes. */
      inputs?: (string | { field: string; value: string })[];
      ticks?: Partial<TickRules>;
      separator?: string;
      splitBy?: string;
      splitIndex?: number;
      splitRegex?: string;
      constantValue?: string;
      expression?: string;
      fillDown?: boolean;
    }[];
    records: { id: string; page?: number | null; index?: number; type?: RowType; struck?: boolean; values: Record<string, FixtureValue> }[];
  };
  existing?: {
    id: string;
    rawRecordId?: string | null;
    recordKey: string | null;
    isVoid?: boolean;
    voidReason?: string | null;
    cells: Record<string, Partial<CellValues> & { id: string }>;
  }[];
  expected: {
    rows: { record: string; key: string; void?: string; cells: Record<string, unknown> }[];
    duplicates?: Record<string, string>;
    flags: string[];
    merge?: unknown;
  };
};

function buildInput(f: Fixture["input"]): TransformInput {
  let position = 0;
  const nextPosition = () => `p${String(position++).padStart(4, "0")}`;
  const fields: TransformField[] = f.fields.map((field) => ({
    labelSource: field.id,
    labelMeaning: null,
    dataType: "TEXT",
    mode: "EXTRACT",
    choices: [],
    markSymbols: null,
    typeOptions: null,
    ...field,
    position: field.position ?? nextPosition(),
  }));
  const pageCounters = new Map<number, number>();
  return {
    kind: f.kind,
    sequenceFieldId: f.sequenceFieldId ?? null,
    fields,
    columns: f.columns.map((c) => ({ id: c.key, label: c.key, dataType: "TEXT", enumValues: [], isRequired: false, ...c })),
    mappings: f.mappings.map((m, i) => ({
      id: `m${i}`,
      outputColumnId: m.column,
      kind: m.kind ?? "COPY",
      separator: m.separator ?? null,
      splitBy: m.splitBy ?? null,
      splitIndex: m.splitIndex ?? null,
      splitRegex: m.splitRegex ?? null,
      constantValue: m.constantValue ?? null,
      expression: m.expression ?? null,
      ticks: m.kind === "TICKS" ? { selection: "ONE_OF", noneMarked: "REVIEW", multipleMarked: "ERROR", noneValue: null, label: null, ...m.ticks } : null,
      fillDown: m.fillDown ?? true,
      inputs: (m.inputs ?? []).map((input) =>
        typeof input === "string" ? { fieldId: input, tickValue: null } : { fieldId: input.field, tickValue: input.value },
      ),
    })),
    book: { numeralSystem: "AUTO", dateEra: "GREGORIAN", ...f.book },
    manualValues: f.manualValues ?? {},
    records: f.records.map((r) => {
      const page = r.page === undefined ? 0 : r.page;
      const n = pageCounters.get(page ?? -1) ?? 0;
      pageCounters.set(page ?? -1, n + 1);
      return {
        id: r.id,
        recordIndex: r.index ?? (page ?? 0) * 1000 + n,
        pageIndex: page,
        rowType: r.type ?? "DATA",
        struckThrough: r.struck ?? false,
        values: Object.entries(r.values).map(([fieldId, v]) => {
          if (v === null) return { fieldId, valueText: null, state: "EMPTY" as const, isDitto: false, confidence: null };
          if (typeof v === "string") return { fieldId, valueText: v, state: "OK" as const, isDitto: false, confidence: null };
          const text = v.text ?? null;
          return { fieldId, valueText: text, state: v.state ?? (text === null ? "EMPTY" : "OK"), isDitto: v.ditto ?? false, confidence: v.confidence ?? null };
        }),
      };
    }),
  };
}

function projectCell(c: ComputedCell): unknown {
  const plainState = c.value === null ? "EMPTY" : "OK";
  if (c.state === plainState && !c.inherited && c.validationState === "NONE") return c.value;
  return {
    value: c.value,
    ...(c.state !== plainState ? { state: c.state } : {}),
    ...(c.inherited ? { inherited: true } : {}),
    ...(c.validationState === "ERROR" ? { error: c.validationMsgs } : c.validationState === "WARNING" ? { warning: c.validationMsgs } : {}),
  };
}

function buildExisting(rows: NonNullable<Fixture["existing"]>): ExistingRow[] {
  return rows.map((r) => ({
    id: r.id,
    rawRecordId: r.rawRecordId ?? null,
    recordKey: r.recordKey,
    isVoid: r.isVoid ?? false,
    voidReason: r.voidReason ?? null,
    cells: Object.entries(r.cells).map(([outputColumnId, c]) => {
      const currentValue = c.currentValue === undefined ? (c.extractedValue ?? null) : c.currentValue;
      return {
        outputColumnId,
        extractedValue: null,
        state: currentValue === null ? "EMPTY" : "OK",
        extractedState: (c.extractedValue ?? null) === null ? "EMPTY" : "OK",
        buildIssues: [],
        isEdited: false,
        isReviewed: false,
        inherited: false,
        confidence: null,
        disagreement: false,
        validationState: "NONE",
        validationMsgs: [],
        ...c,
        currentValue,
      };
    }),
  }));
}

const dir = path.join(__dirname, "golden");
const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();

describe("transform golden files", () => {
  it("has golden files", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    const fixture = JSON.parse(readFileSync(path.join(dir, file), "utf8")) as Fixture;

    it(`${file}: ${fixture.description}`, () => {
      const result = runTransform(buildInput(fixture.input));

      expect(
        result.rows.map((r) => ({
          record: r.rawRecordId,
          key: r.recordKey,
          ...(r.voidReason ? { void: r.voidReason } : {}),
          cells: Object.fromEntries(r.cells.map((c) => [c.outputColumnId, projectCell(c)])),
        })),
      ).toEqual(fixture.expected.rows);
      expect(Object.fromEntries(result.duplicates.map((d) => [d.recordId, d.duplicateOf]))).toEqual(fixture.expected.duplicates ?? {});
      expect(result.flags.map((f) => `${f.kind}: ${f.message}`)).toEqual(fixture.expected.flags);

      if (fixture.existing) {
        let n = 0;
        const plan = planMerge(result.rows, buildExisting(fixture.existing), () => `new${++n}`);
        expect({
          newRowGroups: plan.newRowGroups,
          rowUpdates: plan.rowUpdates,
          cellCreates: plan.cellCreates.length,
          autoCellUpdates: plan.autoCellUpdates.map((u) => ({
            id: u.id,
            extractedValue: u.values.extractedValue,
            currentValue: u.values.currentValue,
            isReviewed: u.values.isReviewed,
          })),
          editedCellUpdates: plan.editedCellUpdates.map((u) => ({
            id: u.id,
            extractedValue: u.extractedValue,
            disagreement: u.disagreement,
            isReviewed: u.isReviewed,
          })),
          rowDeletes: plan.rowDeletes,
          orphanedRows: plan.orphanedRows,
        }).toEqual(fixture.expected.merge);
      }
    });
  }
});
