import { z } from "zod";

import type { ColumnType } from "@/lib/books/schemas";
import { coerceToColumn } from "@/lib/transform/coerce";
import { compareDecimal, formatDecimal, parseDecimal, type Decimal } from "@/lib/transform/decimal";
import { RE2JS } from "re2js";

import { REQUIRED_MESSAGE, uniqueIssues } from "@/lib/transform/run";
import type { BookSettings, Issue, ValidationState, ValueState } from "@/lib/transform/types";
import { idSchema } from "@/lib/validation";

/**
 * Validation rules (docs/01 §16) and how a stored cell's validation state is worked out. Pure and
 * client-safe: the revalidation service, the rule failure counts and the rules editor share it.
 *
 * A cell's validation is, in order: what building its value found (only while nobody edited it; an
 * edited value is checked against the column type instead), the column's required flag, then every
 * enabled rule on its column. Void and deleted rows carry no flags: they don't count.
 */

export const RULE_KINDS = ["REQUIRED", "TYPE", "RANGE", "LENGTH", "REGEX", "ENUM", "UNIQUE", "CROSS_COLUMN", "MONOTONIC"] as const;
export type RuleKind = (typeof RULE_KINDS)[number];

/**
 * What the rules editor puts in front of a data-entry operator, and what it keeps behind Advanced
 * (Phase 14). The split is presentation only: `RULE_KINDS` is untouched, so rules of every kind keep
 * working, keep being checked and keep rendering in the saved list.
 */
export const BASIC_RULE_KINDS = ["REQUIRED", "RANGE", "UNIQUE"] as const;
export const ADVANCED_RULE_KINDS = ["LENGTH", "REGEX", "ENUM", "CROSS_COLUMN", "MONOTONIC"] as const;

/** Everything a person can choose. `TYPE` isn't offered: every value is always checked against its column's type. */
export const OFFERED_RULE_KINDS = [...BASIC_RULE_KINDS, ...ADVANCED_RULE_KINDS] as const;

export const RULE_KIND_LABELS: Record<RuleKind, string> = {
  REQUIRED: "Required",
  TYPE: "Type",
  RANGE: "Range",
  LENGTH: "Length",
  REGEX: "Pattern",
  ENUM: "One of a list",
  UNIQUE: "Unique in the book",
  CROSS_COLUMN: "Compare with another column",
  MONOTONIC: "Increases down the document",
};

export const RULE_SEVERITIES = ["WARNING", "ERROR"] as const;
export type RuleSeverity = (typeof RULE_SEVERITIES)[number];

export const COMPARE_OPERATORS = ["LT", "LTE", "EQ", "NEQ", "GTE", "GT"] as const;
export type CompareOperator = (typeof COMPARE_OPERATORS)[number];

export const OPERATOR_LABELS: Record<CompareOperator, string> = {
  LT: "before / less than",
  LTE: "on or before / at most",
  EQ: "equal to",
  NEQ: "different from",
  GTE: "on or after / at least",
  GT: "after / more than",
};

export const MAX_RULES = 500;
/** Longer values aren't matched against a rule's pattern. RE2 is linear, so this only bounds a pathological value. */
export const MAX_PATTERN_INPUT = 2000;

/**
 * Rule patterns run through RE2 (re2js, pure JS): matching time is linear in the value, so no pattern a person types
 * can stall a check (JavaScript's backtracking engine can take exponential time on patterns like `(a|aa)*$`). The
 * syntax is RE2's: no backreferences or lookarounds, and code points are written `\x{1000}`.
 */
const patternCache = new Map<string, RE2JS>();

export function compilePattern(pattern: string): RE2JS {
  const hit = patternCache.get(pattern);
  if (hit) return hit;
  const compiled = RE2JS.compile(pattern);
  if (patternCache.size >= 200) patternCache.clear();
  patternCache.set(pattern, compiled);
  return compiled;
}

const bound = z.string().trim().max(40).nullable();
const lengthBound = z.number().int().min(0).max(100_000).nullable();

export const ruleSpecSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("REQUIRED"), params: z.object({}) }),
  z.object({ kind: z.literal("TYPE"), params: z.object({}) }),
  z.object({ kind: z.literal("RANGE"), params: z.object({ min: bound, max: bound }) }),
  z.object({ kind: z.literal("LENGTH"), params: z.object({ min: lengthBound, max: lengthBound }) }),
  z.object({ kind: z.literal("REGEX"), params: z.object({ pattern: z.string().min(1, { error: "Enter a pattern." }).max(500) }) }),
  z.object({ kind: z.literal("ENUM"), params: z.object({ values: z.array(z.string().trim().min(1).max(200)).min(1, { error: "Add at least one allowed value." }).max(200) }) }),
  z.object({ kind: z.literal("UNIQUE"), params: z.object({}) }),
  z.object({ kind: z.literal("CROSS_COLUMN"), params: z.object({ otherColumnId: idSchema, operator: z.enum(COMPARE_OPERATORS) }) }),
  z.object({ kind: z.literal("MONOTONIC"), params: z.object({ strict: z.boolean() }) }),
]);

export type RuleSpec = z.infer<typeof ruleSpecSchema>;

export const ruleDraftSchema = z.intersection(
  z.object({
    outputColumnId: idSchema,
    severity: z.enum(RULE_SEVERITIES),
    message: z.string().trim().max(300).nullable().transform((m) => (m === "" ? null : m)),
    enabled: z.boolean(),
  }),
  ruleSpecSchema,
);

export type RuleDraft = z.infer<typeof ruleDraftSchema>;

export type ValidationRuleInput = RuleDraft & { id: string };

/** Stored params that no longer parse (hand-edited, or an old shape) make the rule inert, never a crash. */
export function toRuleInput(row: {
  id: string;
  outputColumnId: string | null;
  kind: RuleKind;
  params: unknown;
  severity: RuleSeverity;
  message: string | null;
  enabled: boolean;
}): ValidationRuleInput | null {
  if (row.outputColumnId === null) return null;
  const spec = ruleSpecSchema.safeParse({ kind: row.kind, params: row.params });
  if (!spec.success) return null;
  return { id: row.id, outputColumnId: row.outputColumnId, severity: row.severity, message: row.message, enabled: row.enabled, ...spec.data };
}

export type ValidationColumn = { id: string; key: string; label: string; dataType: ColumnType; enumValues: string[]; isRequired: boolean };

export type ValidationCell = {
  id: string;
  outputColumnId: string;
  currentValue: string | null;
  state: ValueState;
  isEdited: boolean;
  buildIssues: Issue[];
};

export type ValidationRow = {
  id: string;
  documentId: string;
  position: string;
  /** Void or deleted: no flags. */
  counts: boolean;
  cells: ValidationCell[];
};

export type CellValidation = { validationState: ValidationState; validationMsgs: string[] };

/** `columnId → value → rows`, only for values held by more than one counting row of the book. */
export type Duplicates = ReadonlyMap<string, ReadonlyMap<string, number>>;

export type RuleContext = {
  columns: ReadonlyMap<string, ValidationColumn>;
  book: BookSettings;
  duplicates: Duplicates;
};

const issuesSchema = z.array(z.object({ severity: z.enum(RULE_SEVERITIES), message: z.string() }));

/** Stored build issues, or none when the column is empty or unreadable. */
export function parseIssues(value: unknown): Issue[] {
  const parsed = issuesSchema.safeParse(value);
  return parsed.success ? parsed.data : [];
}

function numberColumn(type: ColumnType): boolean {
  return type === "NUMBER" || type === "INTEGER";
}

function isIsoDate(text: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(text);
  if (!m) return false;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return month >= 1 && month <= 12 && day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** What's wrong with a rule for its column, in plain language, or null. */
export function ruleProblem(rule: RuleDraft, columns: ReadonlyMap<string, ValidationColumn>): string | null {
  const column = columns.get(rule.outputColumnId);
  if (!column) return "That column was deleted. Choose another column.";
  switch (rule.kind) {
    case "REQUIRED":
    case "TYPE":
    case "UNIQUE":
      return null;
    case "RANGE": {
      const { min, max } = rule.params;
      if (!min && !max) return "Enter a minimum, a maximum, or both.";
      if (numberColumn(column.dataType)) {
        const lo = min ? parseDecimal(min) : null;
        const hi = max ? parseDecimal(max) : null;
        if ((min && !lo) || (max && !hi)) return "The minimum and maximum must be plain numbers, such as 0 or 12.5.";
        if (lo && hi && compareDecimal(lo, hi) > 0) return "The minimum is larger than the maximum.";
        return null;
      }
      if (column.dataType === "DATE") {
        if ((min && !isIsoDate(min)) || (max && !isIsoDate(max))) return "Write dates as YYYY-MM-DD, such as 2024-03-31.";
        if (min && max && min > max) return "The earliest date is after the latest date.";
        return null;
      }
      return "Range rules work on number and date columns.";
    }
    case "LENGTH": {
      const { min, max } = rule.params;
      if (min === null && max === null) return "Enter a shortest length, a longest length, or both.";
      if (min !== null && max !== null && min > max) return "The shortest length is longer than the longest length.";
      return null;
    }
    case "REGEX":
      try {
        compilePattern(rule.params.pattern);
        return null;
      } catch {
        return "The pattern isn't a pattern this check understands. Backreferences such as \\1 and lookarounds aren't supported; write a character code as \\x{1000}.";
      }
    case "ENUM":
      return null;
    case "CROSS_COLUMN": {
      const other = columns.get(rule.params.otherColumnId);
      if (!other) return "The column to compare with was deleted. Choose another.";
      if (other.id === column.id) return "Choose a different column to compare with.";
      const kind = compareKind(column.dataType);
      if (kind !== compareKind(other.dataType)) return "Both columns must be numbers, both dates, or both text.";
      if (kind === "text" && rule.params.operator !== "EQ" && rule.params.operator !== "NEQ") {
        return "Text columns can only be compared as equal or different.";
      }
      return null;
    }
    case "MONOTONIC":
      return numberColumn(column.dataType) || column.dataType === "DATE" ? null : "Increasing rules work on number and date columns.";
  }
}

// ---------- evaluation ----------

type Comparable = { kind: "number"; d: Decimal } | { kind: "date"; iso: string } | { kind: "text"; text: string };

function compareKind(type: ColumnType): Comparable["kind"] {
  return numberColumn(type) ? "number" : type === "DATE" ? "date" : "text";
}

/** A cell's value as its column type, or null when empty, not OK, or not parseable. */
function comparable(cell: ValidationCell | undefined, column: ValidationColumn, book: BookSettings): Comparable | null {
  if (!cell || cell.state !== "OK" || cell.currentValue === null || cell.currentValue.trim() === "") return null;
  const kind = compareKind(column.dataType);
  if (kind === "text") return { kind, text: cell.currentValue };
  const coerced = coerceToColumn(cell.currentValue, column, book);
  if (coerced.issues.some((i) => i.severity === "ERROR")) return null;
  if (kind === "date") return isIsoDate(coerced.text) ? { kind, iso: coerced.text } : null;
  const d = parseDecimal(coerced.text);
  return d ? { kind, d } : null;
}

function compare(a: Comparable, b: Comparable): number | null {
  if (a.kind === "number" && b.kind === "number") return compareDecimal(a.d, b.d);
  if (a.kind === "date" && b.kind === "date") return a.iso < b.iso ? -1 : a.iso > b.iso ? 1 : 0;
  if (a.kind === "text" && b.kind === "text") return a.text === b.text ? 0 : a.text < b.text ? -1 : 1;
  return null;
}

function holds(cmp: number, op: CompareOperator): boolean {
  switch (op) {
    case "LT":
      return cmp < 0;
    case "LTE":
      return cmp <= 0;
    case "EQ":
      return cmp === 0;
    case "NEQ":
      return cmp !== 0;
    case "GTE":
      return cmp >= 0;
    case "GT":
      return cmp > 0;
  }
}

const OPERATOR_WORDS: Record<CompareOperator, string> = {
  LT: "less than",
  LTE: "at most",
  EQ: "equal to",
  NEQ: "different from",
  GTE: "at least",
  GT: "more than",
};

const DATE_OPERATOR_WORDS: Record<CompareOperator, string> = {
  LT: "before",
  LTE: "on or before",
  EQ: "the same as",
  NEQ: "different from",
  GTE: "on or after",
  GT: "after",
};

const segmenter = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;

/** Characters as a reader counts them: a Burmese consonant with its marks is one. */
export function graphemeLength(text: string): number {
  if (!segmenter) return [...text].length;
  return Array.from(segmenter.segment(text)).length;
}

function show(value: Comparable): string {
  return value.kind === "number" ? formatDecimal(value.d) : value.kind === "date" ? value.iso : value.text;
}

/** A RANGE bound as a comparable of the value's kind; null when absent or unreadable. */
function rangeBound(text: string | null, kind: Comparable["kind"]): Comparable | null {
  if (!text) return null;
  if (kind === "number") {
    const d = parseDecimal(text);
    return d ? { kind, d } : null;
  }
  return kind === "date" && isIsoDate(text) ? { kind, iso: text } : null;
}

type RowState = { cells: ReadonlyMap<string, ValidationCell> };

/** Per document and MONOTONIC rule: the last comparable value above. */
export type MonotonicMemory = Map<string, Comparable>;

/**
 * The issue one rule raises for one cell, or null. The rule must be enabled and free of problems (`validateRows`
 * checks that once per run). `memory` carries MONOTONIC state down a document; the caller walks a document's
 * counting rows in position order.
 */
function ruleIssue(rule: ValidationRuleInput, cell: ValidationCell, row: RowState, ctx: RuleContext, memory: MonotonicMemory): Issue | null {
  if (rule.outputColumnId !== cell.outputColumnId) return null;
  const column = ctx.columns.get(cell.outputColumnId);
  if (!column) return null;
  const issue = (message: string): Issue => ({ severity: rule.severity, message: rule.message ?? message });
  const value = cell.state === "OK" && cell.currentValue !== null && cell.currentValue !== "" ? cell.currentValue : null;

  switch (rule.kind) {
    case "REQUIRED":
      return value === null && cell.state === "EMPTY" ? issue(REQUIRED_MESSAGE) : null;
    case "TYPE":
      return null;
    case "RANGE": {
      const v = comparable(cell, column, ctx.book);
      if (!v) return null;
      const lo = rangeBound(rule.params.min, v.kind);
      const hi = rangeBound(rule.params.max, v.kind);
      const date = v.kind === "date";
      if (lo && (compare(v, lo) ?? 0) < 0) return issue(date ? `${show(v)} is before the earliest allowed date, ${show(lo)}.` : `${show(v)} is below the minimum, ${show(lo)}.`);
      if (hi && (compare(v, hi) ?? 0) > 0) return issue(date ? `${show(v)} is after the latest allowed date, ${show(hi)}.` : `${show(v)} is above the maximum, ${show(hi)}.`);
      return null;
    }
    case "LENGTH": {
      if (value === null) return null;
      const n = graphemeLength(value);
      if (rule.params.min !== null && n < rule.params.min) return issue(`“${value}” is shorter than ${rule.params.min} characters.`);
      if (rule.params.max !== null && n > rule.params.max) return issue(`“${value}” is longer than ${rule.params.max} characters.`);
      return null;
    }
    case "REGEX": {
      if (value === null || value.length > MAX_PATTERN_INPUT) return null;
      return compilePattern(rule.params.pattern).matcher(value).find() ? null : issue(`“${value}” doesn't match the pattern ${rule.params.pattern}.`);
    }
    case "ENUM": {
      if (value === null) return null;
      const shown = rule.params.values.slice(0, 8).join(", ");
      return rule.params.values.includes(value.trim()) ? null : issue(`“${value}” isn't one of: ${shown}${rule.params.values.length > 8 ? "…" : ""}.`);
    }
    case "UNIQUE": {
      if (value === null) return null;
      const n = ctx.duplicates.get(column.id)?.get(value) ?? 1;
      return n > 1 ? issue(`“${value}” appears in ${n} rows of this book.`) : null;
    }
    case "CROSS_COLUMN": {
      const other = ctx.columns.get(rule.params.otherColumnId);
      if (!other) return null;
      const a = comparable(cell, column, ctx.book);
      const b = comparable(row.cells.get(other.id), other, ctx.book);
      if (!a || !b) return null;
      const cmp = compare(a, b);
      if (cmp === null || holds(cmp, rule.params.operator)) return null;
      const words = a.kind === "date" ? DATE_OPERATOR_WORDS : OPERATOR_WORDS;
      return issue(`${show(a)} should be ${words[rule.params.operator]} ${other.label} (${show(b)}).`);
    }
    case "MONOTONIC": {
      const v = comparable(cell, column, ctx.book);
      if (!v) return null;
      const prev = memory.get(rule.id);
      memory.set(rule.id, v);
      if (!prev) return null;
      const cmp = compare(v, prev);
      if (cmp === null) return null;
      if (cmp < 0) return issue(`${show(v)} is lower than the row above (${show(prev)}).`);
      if (cmp === 0 && rule.params.strict) return issue(`${show(v)} is the same as the row above; each row should be higher.`);
      return null;
    }
  }
}

/** Issues that don't depend on rules: build issues (or, once edited, the column type check) and the required flag. */
export function baseIssues(cell: ValidationCell, column: ValidationColumn, book: BookSettings): Issue[] {
  const issues: Issue[] = [];
  if (!cell.isEdited) issues.push(...cell.buildIssues);
  else if (cell.state === "OK" && cell.currentValue !== null && cell.currentValue !== "") issues.push(...coerceToColumn(cell.currentValue, column, book).issues);
  if (column.isRequired && cell.state === "EMPTY" && (cell.currentValue === null || cell.currentValue === "")) {
    issues.push({ severity: "ERROR", message: REQUIRED_MESSAGE });
  }
  return issues;
}

export function toValidation(issues: Issue[]): CellValidation {
  const unique = uniqueIssues(issues);
  const validationState: ValidationState = unique.some((i) => i.severity === "ERROR") ? "ERROR" : unique.length > 0 ? "WARNING" : "NONE";
  return { validationState, validationMsgs: unique.map((i) => i.message) };
}

function byPosition(a: ValidationRow, b: ValidationRow): number {
  return a.position < b.position ? -1 : a.position > b.position ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export type ValidationRun = {
  cells: Map<string, CellValidation>;
  /** Cells each rule flags, by rule id. */
  ruleHits: Map<string, number>;
};

/**
 * Validates rows. For MONOTONIC rules to be right, every counting row of a document in `rows` must be
 * present; the service loads whole documents whenever the book has one.
 */
export function validateRows(rows: ValidationRow[], rules: ValidationRuleInput[], ctx: RuleContext): ValidationRun {
  const cells = new Map<string, CellValidation>();
  const ruleHits = new Map<string, number>();
  const live = rules.filter((r) => r.enabled && ruleProblem(r, ctx.columns) === null);
  const rulesByColumn = new Map<string, ValidationRuleInput[]>();
  for (const r of live) rulesByColumn.set(r.outputColumnId, [...(rulesByColumn.get(r.outputColumnId) ?? []), r]);

  const byDocument = new Map<string, ValidationRow[]>();
  for (const row of rows) byDocument.set(row.documentId, [...(byDocument.get(row.documentId) ?? []), row]);
  for (const docRows of byDocument.values()) {
    const memory: MonotonicMemory = new Map();
    for (const row of docRows.sort(byPosition)) {
      const state: RowState = { cells: new Map(row.cells.map((c) => [c.outputColumnId, c])) };
      for (const cell of row.cells) {
        const column = ctx.columns.get(cell.outputColumnId);
        if (!row.counts || !column) {
          cells.set(cell.id, { validationState: "NONE", validationMsgs: [] });
          continue;
        }
        const issues = baseIssues(cell, column, ctx.book);
        for (const rule of rulesByColumn.get(cell.outputColumnId) ?? []) {
          const found = ruleIssue(rule, cell, state, ctx, memory);
          if (!found) continue;
          issues.push(found);
          ruleHits.set(rule.id, (ruleHits.get(rule.id) ?? 0) + 1);
        }
        cells.set(cell.id, toValidation(issues));
      }
    }
  }
  return { cells, ruleHits };
}
