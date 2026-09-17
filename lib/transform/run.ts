import { plural } from "@/lib/format";
import { buildTree, selectionOptions } from "@/lib/templates/tree";

import { coerceToColumn } from "./coerce";
import { evaluateExpression, parseExpression, type ParsedExpression } from "./expression";
import type { DocumentFlag } from "./flags";
import { DEFAULT_SEPARATOR, mappingProblem, OPTION_SEPARATOR, optionLabel, sourceId, type MappingContext, type SourceTree } from "./mappings";
import { normaliseReading, type NormValue, type RawReading } from "./normalise";
import { cleanText, numericReading, toLatinDigits } from "./numerals";
import type {
  BookSettings,
  ComputedCell,
  ComputedRow,
  Issue,
  MappingSource,
  NumeralSystem,
  RawRecordInput,
  TransformColumn,
  TransformField,
  TransformInput,
  TransformMapping,
  TransformResult,
  ValueState,
  VoidReason,
} from "./types";

/**
 * The transform pipeline (docs/03 §8): raw records + mappings + book settings → rows and cells.
 * Pure, deterministic and cheap, so it runs again after every mapping or setting change at no AI
 * cost. Steps: filter → ditto → dedupe → sequence check → normalise → selection groups → map →
 * coerce → validate. Merging with existing cells is `merge.ts`.
 */

/** Written in a cell to mean "same as above" (docs/01 §11.1). Compared after NFC, trimmed, lower case. */
const DITTO_TOKENS = new Set(['"', "〃", "”", "“", "''", ",,", "„", "do", "do.", "ditto", "-do-", '-"-']);

export function isDittoToken(text: string | null): boolean {
  return text !== null && DITTO_TOKENS.has(cleanText(text).toLowerCase());
}

type Reading = RawReading & {
  /** The cell held a ditto mark. */
  dittoToken: boolean;
  /** A ditto mark with nothing above it to copy. */
  unresolved: boolean;
};

const warn = (message: string): Issue => ({ severity: "WARNING", message });

/**
 * Longer values aren't matched against a split pattern, which bounds the regex work per cell. Raw
 * readings are a cell of a form or table, far below this, so a real value never misses its pattern.
 */
const MAX_PATTERN_INPUT = 2000;

type WorkingMapping = { mapping: TransformMapping; parsed: ParsedExpression | null; pattern: RegExp | null };

function emptyValue(issues: Issue[] = []): NormValue {
  return { text: null, state: "EMPTY", confidence: null, inherited: false, mark: null, issues };
}

function minConfidence(values: (number | null)[]): number | null {
  const real = values.filter((v): v is number => v !== null);
  return real.length === 0 ? null : Math.min(...real);
}

function hasReading(r: RawReading): boolean {
  return r.state !== "EMPTY" && !(r.state === "OK" && cleanText(r.valueText ?? "") === "");
}

/** Step 1: SUBTOTAL/TOTAL/NOTE rows and struck-through rows stay, void (visible, not counted). */
export function voidReasonOf(record: RawRecordInput): VoidReason | null {
  if (record.rowType === "SUBTOTAL" || record.rowType === "TOTAL" || record.rowType === "NOTE") return record.rowType;
  return record.struckThrough ? "STRUCK_THROUGH" : null;
}

function readingOrder(a: RawRecordInput, b: RawRecordInput): number {
  return a.recordIndex - b.recordIndex || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * Step 2: resolve ditto marks per field, walking records in reading order across pages. A ditto takes
 * the last value read in a data row above it (blank cells are skipped); it is marked inherited. MANUAL
 * values apply to every record of the document.
 */
function resolveReadings(
  records: RawRecordInput[],
  fields: ReadonlyMap<string, TransformField>,
  manualValues: Record<string, string>,
): Map<string, Map<string, Reading>> {
  const last = new Map<string, Reading>();
  const out = new Map<string, Map<string, Reading>>();
  const manual = Object.entries(manualValues).filter(([id]) => fields.get(id)?.mode === "MANUAL");
  for (const record of records) {
    const isSource = voidReasonOf(record) === null;
    const values = new Map<string, Reading>();
    for (const v of record.values) {
      if (fields.get(v.fieldId)?.mode !== "EXTRACT") continue;
      const token = v.isDitto || (v.state === "OK" && isDittoToken(v.valueText));
      let reading: Reading;
      if (token) {
        const prev = last.get(v.fieldId);
        reading = prev
          ? { ...prev, confidence: minConfidence([prev.confidence, v.confidence]), inherited: true, dittoToken: true, unresolved: false }
          : { valueText: null, state: "EMPTY", confidence: v.confidence, inherited: false, dittoToken: true, unresolved: true };
      } else {
        reading = { valueText: v.valueText, state: v.state, confidence: v.confidence, inherited: false, dittoToken: false, unresolved: false };
      }
      values.set(v.fieldId, reading);
      if (isSource && hasReading(reading)) last.set(v.fieldId, reading);
    }
    for (const [fieldId, text] of manual) {
      const state: ValueState = cleanText(text) === "" ? "EMPTY" : "OK";
      values.set(fieldId, { valueText: text, state, confidence: null, inherited: false, dittoToken: false, unresolved: false });
    }
    out.set(record.id, values);
  }
  return out;
}

function sequenceKey(values: ReadonlyMap<string, Reading> | undefined, fieldId: string | null, system: NumeralSystem): string | null {
  if (fieldId === null) return null;
  const v = values?.get(fieldId);
  if (!v || v.state !== "OK") return null;
  const key = numericReading(v.valueText ?? "", system).text.replace(/[\s.]/gu, "");
  return key === "" ? null : key;
}

/** Comparable readings of a record, empty cells left out. */
function signature(values: ReadonlyMap<string, Reading> | undefined, skipFieldId: string | null): Map<string, string> {
  const sig = new Map<string, string>();
  for (const [fieldId, v] of values ?? []) {
    if (fieldId === skipFieldId || !hasReading(v)) continue;
    sig.set(fieldId, v.state === "OK" ? `OK:${toLatinDigits(cleanText(v.valueText ?? "")).toLowerCase()}` : v.state);
  }
  return sig;
}

const within = (a: Map<string, string>, b: Map<string, string>) => [...a].every(([k, v]) => b.get(k) === v);

/**
 * Step 3: overlap dedupe by sequence value. Two data rows from different pages with the same number,
 * whose other readings are equal or one a subset of the other, are one row: the more complete one is
 * kept (the earlier one on a tie) and the other becomes its duplicate.
 */
function dedupe(
  records: RawRecordInput[],
  readings: Map<string, Map<string, Reading>>,
  sequenceFieldId: string,
  system: NumeralSystem,
): Map<string, string> {
  const duplicateOf = new Map<string, string>();
  const kept = new Map<string, RawRecordInput[]>();
  for (const r of records) {
    if (r.rowType !== "DATA" || voidReasonOf(r) !== null) continue;
    const key = sequenceKey(readings.get(r.id), sequenceFieldId, system);
    if (key === null) continue;
    const list = kept.get(key) ?? [];
    kept.set(key, list);
    const sr = signature(readings.get(r.id), sequenceFieldId);
    let placed = false;
    for (let i = 0; i < list.length && !placed; i++) {
      const k = list[i];
      if (!k || r.pageIndex === null || k.pageIndex === null || r.pageIndex === k.pageIndex) continue;
      const sk = signature(readings.get(k.id), sequenceFieldId);
      // A row with nothing but its number would be a "subset" of any row: leave it to the repeat flag.
      if (sr.size === 0 || sk.size === 0) continue;
      if (within(sr, sk)) {
        duplicateOf.set(r.id, k.id);
        placed = true;
      } else if (within(sk, sr)) {
        duplicateOf.set(k.id, r.id);
        for (const [dup, target] of duplicateOf) if (target === k.id) duplicateOf.set(dup, r.id);
        list[i] = r;
        placed = true;
      }
    }
    if (!placed) list.push(r);
  }
  return duplicateOf;
}

/** Without a sequence field nothing is deduped; identical rows on consecutive pages are only flagged. */
function suspectedDuplicates(records: RawRecordInput[], readings: Map<string, Map<string, Reading>>): number {
  const byPage = new Map<number, Map<string, string>[]>();
  const data = records.filter((r) => r.rowType === "DATA" && voidReasonOf(r) === null && r.pageIndex !== null);
  for (const r of data) {
    const list = byPage.get(r.pageIndex ?? -1) ?? [];
    list.push(signature(readings.get(r.id), null));
    byPage.set(r.pageIndex ?? -1, list);
  }
  let count = 0;
  for (const r of data) {
    const sig = signature(readings.get(r.id), null);
    if (sig.size < 2) continue;
    const above = byPage.get((r.pageIndex ?? 0) - 1) ?? [];
    if (above.some((q) => within(q, sig) && within(sig, q))) count++;
  }
  return count;
}

function listOf(items: string[]): string {
  const shown = items.slice(0, 5);
  const more = items.length - shown.length;
  const head = shown.length > 1 ? `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}` : (shown[0] ?? "");
  return more > 0 ? `${shown.join(", ")} and ${more} more` : head;
}

/** Step 4: the sequence column should count up by one. Gaps, repeats and backwards steps are document flags. */
function sequenceFlags(
  records: RawRecordInput[],
  readings: Map<string, Map<string, Reading>>,
  field: TransformField,
  system: NumeralSystem,
): DocumentFlag[] {
  const name = `“${field.labelSource}”`;
  const gaps: string[] = [];
  const repeats: string[] = [];
  const backwards: string[] = [];
  let unreadable = 0;
  let prev: number | null = null;
  for (const r of records) {
    const key = sequenceKey(readings.get(r.id), field.id, system);
    const n = key !== null && /^\d{1,9}$/u.test(key) ? Number(key) : null;
    if (n === null) {
      unreadable++;
      continue;
    }
    if (prev !== null) {
      if (n === prev) {
        if (!repeats.includes(String(n))) repeats.push(String(n));
      } else if (n < prev) {
        backwards.push(`${n} after ${prev}`);
      } else if (n > prev + 1) {
        gaps.push(n - 1 === prev + 1 ? String(prev + 1) : `${prev + 1}–${n - 1}`);
      }
    }
    prev = n;
  }
  const flags: DocumentFlag[] = [];
  if (gaps.length > 0) flags.push({ kind: "SEQUENCE_GAP", message: `The numbers in ${name} skip ${listOf(gaps)}. Rows may be missing.` });
  if (repeats.length > 0) flags.push({ kind: "SEQUENCE_REPEAT", message: `The numbers in ${name} repeat: ${listOf(repeats)}. Check for duplicate rows.` });
  if (backwards.length > 0) flags.push({ kind: "SEQUENCE_ORDER", message: `The numbers in ${name} go backwards: ${listOf(backwards)}.` });
  if (unreadable > 0) {
    flags.push({ kind: "SEQUENCE_UNREADABLE", message: `${plural(unreadable, "row")} ${unreadable === 1 ? "has" : "have"} no readable number in ${name}.` });
  }
  return flags;
}

// ---------- per record ----------

type Reader = {
  field: (fieldId: string, fillDown: boolean) => NormValue;
  group: (source: Extract<MappingSource, { kind: "group" }>, fillDown: boolean) => NormValue;
};

function makeReader(
  values: ReadonlyMap<string, Reading>,
  fields: ReadonlyMap<string, TransformField>,
  tree: SourceTree,
  book: BookSettings,
): Reader {
  const cache = new Map<string, NormValue>();
  const field = (fieldId: string, fillDown: boolean): NormValue => {
    const cacheKey = `${fieldId}:${fillDown}`;
    const hit = cache.get(cacheKey);
    if (hit) return hit;
    const f = fields.get(fieldId);
    const raw = values.get(fieldId);
    let value: NormValue;
    if (!f || f.mode === "SKIP" || !raw) value = emptyValue();
    else if (raw.dittoToken && !fillDown) value = emptyValue([warn("A ditto mark isn't filled in because fill-down is off for this column.")]);
    else if (raw.unresolved) value = emptyValue([warn("A ditto mark has no value above it to copy.")]);
    else value = normaliseReading(f, raw, book);
    cache.set(cacheKey, value);
    return value;
  };

  /** Step 5a: a selection group's answer from its option ticks (docs/03 §8 step 5a). */
  const group: Reader["group"] = (source, fillDown) => {
    const node = tree.groups.get(source.groupId);
    if (!node) return emptyValue();
    const name = `“${node.group.labelSource}”`;
    const options = selectionOptions(node).map((option) => ({ option, value: field(option.id, fillDown) }));
    const issues = options.flatMap((o) => o.value.issues);
    const ticked = options.filter((o) => o.value.mark?.ticked === true);
    const unclear = options.filter((o) => o.value.state === "ILLEGIBLE" || o.value.mark?.ticked === null);
    const base = {
      confidence: minConfidence(options.map((o) => o.value.confidence)),
      inherited: ticked.some((o) => o.value.inherited),
      mark: null,
    };
    // An unreadable tick is always flagged and never read as "nothing ticked".
    if (unclear.length > 0) issues.push(warn(`A tick in ${name} couldn't be read, so the answer needs checking.`));

    if (ticked.length === 0) {
      if (unclear.length > 0) return { ...base, text: null, state: "ILLEGIBLE", issues };
      const rule = node.group.noneMarked;
      if (rule !== "BLANK") issues.push({ severity: rule === "ERROR" ? "ERROR" : "WARNING", message: `Nothing is ticked in ${name}.` });
      const text = source.noneValue === null || source.noneValue === "" ? null : source.noneValue;
      return { ...base, text, state: text === null ? "EMPTY" : "OK", issues };
    }
    if (node.group.selection === "ONE_OF" && ticked.length > 1) {
      const labels = ticked.map((o) => optionLabel(tree, node.id, o.option.id)).join(", ");
      issues.push({
        severity: node.group.multipleMarked === "ERROR" ? "ERROR" : "WARNING",
        message: `Several options are ticked in ${name} (${labels}), so none was picked.`,
      });
      return { ...base, text: null, state: "EMPTY", issues };
    }
    const text = ticked.map((o) => source.optionValues[o.option.id] ?? optionLabel(tree, node.id, o.option.id)).join(OPTION_SEPARATOR);
    return { ...base, text, state: "OK", issues };
  };

  return { field, group };
}

/** The cell state for a mapped value: OK when there is text, else what its inputs agree on. */
function combine(values: NormValue[], text: string | null, extra: Issue[] = []): NormValue {
  const issues = [...values.flatMap((v) => v.issues), ...extra];
  const illegible = values.some((v) => v.state === "ILLEGIBLE");
  let state: ValueState;
  if (text !== null && text !== "") {
    state = "OK";
    if (illegible && values.length > 1) issues.push(warn("Part of this value couldn't be read."));
  } else if (illegible) {
    state = "ILLEGIBLE";
  } else {
    const states = new Set(values.map((v) => v.state));
    const only = states.size === 1 ? [...states][0] : undefined;
    state = only === "DASH" || only === "NOT_APPLICABLE" ? only : "EMPTY";
  }
  return {
    text: text === "" ? null : text,
    state,
    confidence: minConfidence(values.map((v) => v.confidence)),
    inherited: values.some((v) => v.inherited),
    mark: null,
    issues,
  };
}

function applyMapping({ mapping: m, parsed, pattern }: WorkingMapping, reader: Reader): NormValue {
  const read = (s: MappingSource | undefined): NormValue =>
    s?.kind === "field" ? reader.field(s.fieldId, m.fillDown) : s?.kind === "group" ? reader.group(s, m.fillDown) : emptyValue();
  switch (m.kind) {
    case "COPY": {
      const v = read(m.inputs[0]);
      return combine([v], v.text);
    }
    case "CONCAT": {
      const values = m.inputs.map(read);
      const parts = values.flatMap((v) => (v.text === null ? [] : [v.text]));
      return combine(values, parts.length > 0 ? parts.join(m.separator ?? DEFAULT_SEPARATOR) : null);
    }
    case "SPLIT": {
      const v = read(m.inputs[0]);
      if (v.text === null) return combine([v], null);
      if (m.splitRegex !== null) {
        if (!pattern) return combine([v], null);
        if (v.text.length > MAX_PATTERN_INPUT) {
          return combine([v], null, [warn(`This value is longer than ${MAX_PATTERN_INPUT.toLocaleString("en-US")} characters, so the split pattern wasn't matched against it.`)]);
        }
        const part = pattern.exec(v.text)?.[1]?.trim() ?? "";
        return combine([v], part, part === "" ? [warn(`“${v.text}” doesn't match the split pattern.`)] : []);
      }
      const index = m.splitIndex ?? 0;
      const part = v.text.split(m.splitBy ?? DEFAULT_SEPARATOR)[index]?.trim() ?? "";
      return combine([v], part, part === "" ? [warn(`“${v.text}” has no part ${index + 1} when split on “${m.splitBy ?? ""}”.`)] : []);
    }
    case "CONSTANT":
      return combine([], m.constantValue);
    case "EXPRESSION": {
      const values = new Map<string, NormValue>();
      for (const s of m.inputs) {
        const id = sourceId(s);
        if (id !== null) values.set(id, read(s));
      }
      const all = [...values.values()];
      if (!parsed) return combine(all, null, [{ severity: "ERROR", message: "The expression can't be read." }]);
      const result = evaluateExpression(parsed, (id) => values.get(id)?.text ?? null);
      if ("error" in result) return combine(all, null, [{ severity: "ERROR", message: `The expression failed: ${result.error}` }]);
      return combine(all, result.value);
    }
  }
}

/** Shown for an empty cell in a required column; validation (lib/validation/rules.ts) raises it for stored cells. */
export const REQUIRED_MESSAGE = "This column is required.";

/** Errors first, each message once. */
export function uniqueIssues(issues: Issue[]): Issue[] {
  const seen = new Set<string>();
  const out: Issue[] = [];
  for (const severity of ["ERROR", "WARNING"] as const) {
    for (const i of issues) {
      if (i.severity !== severity || seen.has(i.message)) continue;
      seen.add(i.message);
      out.push(i);
    }
  }
  return out;
}

function uniqueMessages(issues: Issue[]): string[] {
  const errors = issues.filter((i) => i.severity === "ERROR").map((i) => i.message);
  const warnings = issues.filter((i) => i.severity === "WARNING").map((i) => i.message);
  return [...new Set([...errors, ...warnings])];
}

/** Steps 7–8: coerce to the column type, then validate. Void rows carry no flags: they don't count. */
function finishCell(column: TransformColumn, v: NormValue, voidReason: VoidReason | null, book: BookSettings): ComputedCell {
  let value = v.text;
  const issues = [...v.issues];
  if (value !== null) {
    const coerced = coerceToColumn(value, column, book);
    value = coerced.text;
    issues.push(...coerced.issues);
  }
  const cell = { outputColumnId: column.id, value, state: v.state, inherited: v.inherited, confidence: v.confidence };
  if (voidReason !== null) return { ...cell, buildIssues: [], validationState: "NONE", validationMsgs: [] };
  const buildIssues = uniqueIssues(issues);
  if (column.isRequired && value === null && v.state === "EMPTY") issues.push({ severity: "ERROR", message: REQUIRED_MESSAGE });
  const validationState = issues.some((i) => i.severity === "ERROR") ? "ERROR" : issues.length > 0 ? "WARNING" : "NONE";
  return { ...cell, buildIssues, validationState, validationMsgs: uniqueMessages(issues) };
}

// ---------- entry point ----------

/**
 * The mapping that fills each column: the first, in the given (position) order, that works (docs/01 §8). Broken
 * mappings and expressions that don't parse are skipped. The table's Manual/Skip tints use this too.
 */
export function firstWorkingMappings(mappings: TransformMapping[], context: MappingContext): Map<string, TransformMapping> {
  const out = new Map<string, TransformMapping>();
  for (const mapping of mappings) {
    if (out.has(mapping.outputColumnId) || mappingProblem(mapping, context) !== null) continue;
    if (mapping.kind === "EXPRESSION" && mapping.expression !== null && !parseExpression(mapping.expression).ok) continue;
    out.set(mapping.outputColumnId, mapping);
  }
  return out;
}

export function runTransform(input: TransformInput): TransformResult {
  const tree: SourceTree = buildTree(input.groups, input.fields);
  const fields = new Map(input.fields.map((f) => [f.id, f]));
  const system = input.book.numeralSystem;

  const records = input.records.filter((r) => r.rowType !== "HEADER").sort(readingOrder);
  const readings = resolveReadings(records, fields, input.manualValues);

  const sequenceField = input.kind === "TABLE" && input.sequenceFieldId !== null ? fields.get(input.sequenceFieldId) : undefined;
  const sequenceFieldId = sequenceField?.mode === "EXTRACT" ? sequenceField.id : null;
  const flags: DocumentFlag[] = [];

  const duplicateOf = sequenceFieldId !== null ? dedupe(records, readings, sequenceFieldId, system) : new Map<string, string>();
  if (input.kind === "TABLE" && sequenceFieldId === null) {
    const suspected = suspectedDuplicates(records, readings);
    if (suspected > 0) {
      flags.push({
        kind: "SUSPECTED_DUPLICATES",
        message: `${plural(suspected, "row")} ${suspected === 1 ? "repeats a row" : "repeat rows"} from the page before. If the photos overlap, choose a sequence field so repeated rows are removed.`,
      });
    }
  }
  const output = records.filter((r) => !duplicateOf.has(r.id));
  if (sequenceField && sequenceFieldId !== null) {
    flags.push(...sequenceFlags(output.filter((r) => r.rowType === "DATA" && voidReasonOf(r) === null), readings, sequenceField, system));
  }

  // Expressions are parsed and split patterns compiled once per mapping, not per cell.
  const byColumn = new Map<string, WorkingMapping>();
  for (const [columnId, mapping] of firstWorkingMappings(input.mappings, { tree, liveColumnIds: new Set(input.columns.map((c) => c.id)) })) {
    const parsed = mapping.kind === "EXPRESSION" && mapping.expression !== null ? parseExpression(mapping.expression) : null;
    const pattern = mapping.kind === "SPLIT" && mapping.splitRegex !== null ? new RegExp(mapping.splitRegex, "u") : null;
    byColumn.set(columnId, { mapping, parsed: parsed?.ok ? parsed.value : null, pattern });
  }

  let unresolvedDittos = 0;
  let flaggedCells = 0;
  const keyCounts = new Map<string, number>();
  const rows: ComputedRow[] = output.map((record, i) => {
    const values = readings.get(record.id) ?? new Map<string, Reading>();
    const voidReason = voidReasonOf(record);
    const reader = makeReader(values, fields, tree, input.book);
    const cells = input.columns.map((column) => {
      const entry = byColumn.get(column.id);
      return finishCell(column, entry ? applyMapping(entry, reader) : emptyValue(), voidReason, input.book);
    });
    if (voidReason === null) {
      unresolvedDittos += [...values.values()].filter((v) => v.unresolved).length;
      flaggedCells += cells.filter((c) => c.validationState !== "NONE").length;
    }
    const sequence = sequenceKey(values, sequenceFieldId, system);
    const base = input.kind === "FORM" ? "form" : sequence !== null ? `seq:${sequence}` : `row:${i + 1}`;
    const n = (keyCounts.get(base) ?? 0) + 1;
    keyCounts.set(base, n);
    return { rawRecordId: record.id, recordKey: n === 1 ? base : `${base}#${n}`, voidReason, cells };
  });

  if (unresolvedDittos > 0) {
    flags.push({
      kind: "UNRESOLVED_DITTO",
      message: `${plural(unresolvedDittos, "ditto mark")} ${unresolvedDittos === 1 ? "has" : "have"} no value above to copy.`,
    });
  }
  if (flaggedCells > 0) {
    flags.push({ kind: "CELLS_FLAGGED", message: `${plural(flaggedCells, "cell")} ${flaggedCells === 1 ? "was" : "were"} flagged while building rows.` });
  }

  return {
    rows,
    duplicates: [...duplicateOf].map(([recordId, target]) => ({ recordId, duplicateOf: target })),
    flags,
  };
}
