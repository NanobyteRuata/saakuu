import { z } from "zod";

import { fieldAliases } from "./aliases";
import {
  CONTENT_STATES,
  ROW_TYPES,
  VALUE_STATES,
  type Bbox,
  type ExtractedContentState,
  type RawRecordDTO,
  type TemplateSnapshot,
} from "./provider";

/**
 * Validates a model response before anything touches the database (docs/03 §2). Values are kept
 * verbatim; the only changes are clamping bounding boxes and confidence into 0..1 and dropping values
 * for Skip fields (the model was told to ignore those). Anything that would bind a value to the wrong
 * place is an issue, which triggers one repair request.
 *
 * Since prompt v2 (Phase 23, decision 83) the model names fields by alias and leaves a table's blank
 * cells out. Aliases are turned back into field ids here, and every Extract field a TABLE record does
 * not list is stored as EMPTY, so the raw layer has the shape it always had. A FORM record is not
 * filled: there a field left out was not found on the page, which is not the same as blank.
 */

const looseBbox = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() });

const valueSchema = z.object({
  fieldId: z.string(),
  valueText: z.string().nullable().optional(),
  altValueText: z.string().nullable().optional(),
  state: z.enum(VALUE_STATES),
  isDitto: z.boolean().optional(),
  confidence: z.number().nullable().optional(),
  bbox: looseBbox.nullable().optional(),
});

const recordSchema = z.object({
  recordIndex: z.number().int().min(0),
  rowType: z.enum(ROW_TYPES).optional(),
  struckThrough: z.boolean().optional(),
  pageIndex: z.number().int(),
  values: z.array(valueSchema),
});

const responseSchema = z.object({
  contentState: z.enum(CONTENT_STATES),
  anchorsFound: z.array(z.string()).optional(),
  records: z.array(recordSchema),
});

export const MAX_RECORDS_PER_REQUEST = 1000;

export type ValidatedExtraction = {
  contentState: ExtractedContentState;
  anchorsFound: string[];
  records: RawRecordDTO[];
};

export type ValidationOutcome = { ok: true; value: ValidatedExtraction } | { ok: false; issues: string[] };

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

function clampBbox(b: z.infer<typeof looseBbox> | null | undefined): Bbox | null {
  if (!b) return null;
  const x = clamp01(b.x);
  const y = clamp01(b.y);
  return { x, y, w: clamp01(Math.min(b.w, 1 - x)), h: clamp01(Math.min(b.h, 1 - y)) };
}

const normaliseAnchor = (s: string) => s.normalize("NFC").trim().toLowerCase();

export function validateExtraction(json: unknown, template: TemplateSnapshot, pageIndexes: number[]): ValidationOutcome {
  const parsed = responseSchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.slice(0, 20).map((i) => `${i.path.join(".") || "response"}: ${i.message}`) };
  }
  const { idOf } = fieldAliases(template);
  const extractFields = template.fields.filter((f) => f.mode === "EXTRACT");
  const extractIds = new Set(extractFields.map((f) => f.id));
  const skipIds = new Set(template.fields.filter((f) => f.mode === "SKIP").map((f) => f.id));
  const pages = new Set(pageIndexes);
  const issues: string[] = [];
  const { contentState, records } = parsed.data;

  if (contentState !== "HAS_CONTENT" && records.length > 0) {
    issues.push(`contentState is ${contentState} but ${records.length} records were returned; use HAS_CONTENT or return no records.`);
  }
  if (template.kind === "FORM" && records.length > 1) {
    issues.push(`This is a form: return exactly one record, not ${records.length}.`);
  }
  if (records.length > MAX_RECORDS_PER_REQUEST) {
    issues.push(`Too many records (${records.length}).`);
  }

  const out: RawRecordDTO[] = [];
  records.forEach((r, i) => {
    if (!pages.has(r.pageIndex)) issues.push(`records[${i}].pageIndex ${r.pageIndex} is not one of the pages sent (${pageIndexes.join(", ")}).`);
    const seen = new Set<string>();
    const values: RawRecordDTO["values"] = [];
    r.values.forEach((v, j) => {
      // Issues quote the alias: it is what the model wrote and what the repair request shows it.
      const fieldId = idOf.get(v.fieldId);
      if (fieldId !== undefined && skipIds.has(fieldId)) return;
      if (fieldId === undefined || !extractIds.has(fieldId)) {
        issues.push(`records[${i}].values[${j}].fieldId "${v.fieldId}" is not a field to extract. Use only the listed fieldId values.`);
        return;
      }
      if (seen.has(fieldId)) {
        issues.push(`records[${i}] reports fieldId "${v.fieldId}" more than once.`);
        return;
      }
      seen.add(fieldId);
      values.push({
        fieldId,
        valueText: v.valueText ?? null,
        altValueText: v.altValueText ?? null,
        state: v.state,
        isDitto: v.isDitto ?? false,
        confidence: v.confidence === null || v.confidence === undefined ? null : clamp01(v.confidence),
        bbox: clampBbox(v.bbox),
      });
    });
    if (template.kind === "TABLE") {
      for (const f of extractFields) {
        if (!seen.has(f.id)) values.push({ fieldId: f.id, valueText: null, altValueText: null, state: "EMPTY", isDitto: false, confidence: null, bbox: null });
      }
    }
    out.push({
      recordIndex: r.recordIndex,
      rowType: r.rowType ?? "DATA",
      struckThrough: r.struckThrough ?? false,
      pageIndex: r.pageIndex,
      values,
    });
  });
  if (issues.length > 0) return { ok: false, issues: issues.slice(0, 20) };

  // Only anchors the template declares count; matching ignores case and surrounding spaces.
  const wanted = new Map(template.anchors.map((a) => [normaliseAnchor(a), a]));
  const anchorsFound = [
    ...new Set((parsed.data.anchorsFound ?? []).flatMap((a) => {
      const hit = wanted.get(normaliseAnchor(a));
      return hit === undefined ? [] : [hit];
    })),
  ];
  // Records keep the order they were returned in: that is the model's reading order.
  return { ok: true, value: { contentState, anchorsFound, records: out } };
}
