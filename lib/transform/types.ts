import type { DateEra, NumeralSystem, RowType, ValueState } from "@/lib/ai/provider";
import type { ColumnType } from "@/lib/books/schemas";
import type {
  FieldMode,
  FieldType,
  FieldTypeOptions,
  MarkSymbols,
  MultipleMarked,
  NoneMarked,
  TemplateKind,
  TickSelection,
} from "@/lib/templates/schemas";

import type { DocumentFlag } from "./flags";

/**
 * Transform layer types (docs/03 §8). Pure and client-safe: the worker, the mapping preview and the
 * golden-file tests all go through the same shapes.
 */

export const MAPPING_KINDS = ["COPY", "CONCAT", "SPLIT", "CONSTANT", "EXPRESSION", "TICKS"] as const;
export type MappingKind = (typeof MAPPING_KINDS)[number];

export type { DateEra, NumeralSystem, RowType, ValueState };

export type ValidationState = "NONE" | "WARNING" | "ERROR";
export type Severity = "WARNING" | "ERROR";
export type Issue = { severity: Severity; message: string };

/** Live fields only. Values of deleted fields are orphans and never reach a cell. */
export type TransformField = {
  id: string;
  labelSource: string;
  labelMeaning: string | null;
  position: string;
  dataType: FieldType;
  mode: FieldMode;
  choices: string[];
  markSymbols: MarkSymbols | null;
  /** Settings for the field's type, e.g. how a DATE field reads two-digit years. */
  typeOptions: FieldTypeOptions | null;
};

/** Live output columns, in manual order. */
export type TransformColumn = {
  id: string;
  key: string;
  label: string;
  dataType: ColumnType;
  enumValues: string[];
  isRequired: boolean;
};

/** One field a mapping reads. `tickValue` is what a TICKS mapping writes when this field is ticked; null = the field's own words. */
export type MappingSource = { fieldId: string; tickValue: string | null };

/**
 * How a TICKS mapping turns its tick fields into one answer (docs/03 §8 step 5a, decisions 32, 33
 * and 84). `label` is the name warnings use; null = the column's label.
 */
export type TickRules = {
  selection: TickSelection;
  noneMarked: NoneMarked;
  multipleMarked: MultipleMarked;
  /** Exported when nothing is ticked. */
  noneValue: string | null;
  label: string | null;
};

export type TransformMapping = {
  id: string;
  outputColumnId: string;
  kind: MappingKind;
  separator: string | null;
  splitBy: string | null;
  splitIndex: number | null;
  splitRegex: string | null;
  constantValue: string | null;
  expression: string | null;
  /** TICKS only. */
  ticks: TickRules | null;
  fillDown: boolean;
  /** In input order. */
  inputs: MappingSource[];
};

export type RawValueInput = {
  fieldId: string;
  valueText: string | null;
  state: ValueState;
  isDitto: boolean;
  confidence: number | null;
};

export type RawRecordInput = {
  id: string;
  recordIndex: number;
  /** Page of the document the record was read from; null when unknown. */
  pageIndex: number | null;
  rowType: RowType;
  struckThrough: boolean;
  values: RawValueInput[];
};

export type BookSettings = { numeralSystem: NumeralSystem; dateEra: DateEra };

export type TransformInput = {
  kind: TemplateKind;
  sequenceFieldId: string | null;
  fields: TransformField[];
  columns: TransformColumn[];
  /** In mapping order; the first working mapping for a column fills it. */
  mappings: TransformMapping[];
  book: BookSettings;
  /** MANUAL-mode values typed once per document: { fieldId: value }. */
  manualValues: Record<string, string>;
  records: RawRecordInput[];
};

export type ComputedCell = {
  outputColumnId: string;
  value: string | null;
  state: ValueState;
  inherited: boolean;
  confidence: number | null;
  /** What building the value found (normalising, mapping, coercion). Stored on the cell; validation adds rules to it. */
  buildIssues: Issue[];
  /** Build issues plus the required-column check, as the mapping preview shows them. */
  validationState: ValidationState;
  validationMsgs: string[];
};

/** Why a row is void by rule. `ORPHANED`: a row with your edits that no longer matches the extraction. */
export const VOID_REASONS = ["SUBTOTAL", "TOTAL", "NOTE", "STRUCK_THROUGH", "ORPHANED"] as const;
export type VoidReason = (typeof VOID_REASONS)[number];

export type ComputedRow = {
  rawRecordId: string;
  /** Stable identity within the document, so a re-extraction finds the row it replaces. */
  recordKey: string;
  voidReason: VoidReason | null;
  cells: ComputedCell[];
};

export type TransformResult = {
  rows: ComputedRow[];
  /** Overlap dedupe: records dropped as copies of another record. */
  duplicates: { recordId: string; duplicateOf: string }[];
  flags: DocumentFlag[];
};
