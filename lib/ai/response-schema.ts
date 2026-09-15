import { CONTENT_STATES, ROW_TYPES, VALUE_STATES, type TemplateSnapshot } from "./provider";

/**
 * The structured-output schema for one template (docs/03 §2), as plain JSON Schema. Providers that
 * take a different dialect convert it inside their own implementation.
 */

export type JsonSchema = Record<string, unknown>;

const nullableString = { type: ["string", "null"] };

export function extractionResponseSchema(template: TemplateSnapshot, pageIndexes: number[]): JsonSchema {
  const fieldIds = template.fields.filter((f) => f.mode === "EXTRACT").map((f) => f.id);
  const bbox = {
    type: ["object", "null"],
    properties: { x: { type: "number" }, y: { type: "number" }, w: { type: "number" }, h: { type: "number" } },
    required: ["x", "y", "w", "h"],
  };
  const value = {
    type: "object",
    properties: {
      fieldId: { type: "string", enum: fieldIds },
      valueText: nullableString,
      altValueText: nullableString,
      state: { type: "string", enum: [...VALUE_STATES] },
      isDitto: { type: "boolean" },
      confidence: { type: ["number", "null"] },
      bbox,
    },
    required: ["fieldId", "valueText", "state", "isDitto"],
  };
  const record = {
    type: "object",
    properties: {
      recordIndex: { type: "integer" },
      rowType: { type: "string", enum: [...ROW_TYPES] },
      struckThrough: { type: "boolean" },
      pageIndex: { type: "integer", enum: pageIndexes },
      values: { type: "array", items: value },
    },
    required: ["recordIndex", "rowType", "struckThrough", "pageIndex", "values"],
  };
  return {
    type: "object",
    properties: {
      contentState: { type: "string", enum: [...CONTENT_STATES] },
      anchorsFound: { type: "array", items: { type: "string" } },
      records: { type: "array", items: record },
    },
    required: ["contentState", "anchorsFound", "records"],
  };
}
