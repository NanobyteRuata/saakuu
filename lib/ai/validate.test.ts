import { describe, expect, it } from "vitest";

import type { SnapshotField, TemplateSnapshot } from "./provider";
import { validateExtraction } from "./validate";

function field(id: string, mode: SnapshotField["mode"] = "EXTRACT"): SnapshotField {
  return { id, path: [{ label: id, meaning: null }], dataType: "TEXT", mode, note: null, choices: [], markSymbols: null, isSequence: false };
}

const template = (kind: TemplateSnapshot["kind"]): TemplateSnapshot => ({
  id: "t1",
  kind,
  languageHint: "my",
  instructions: null,
  anchors: ["ကာကွယ်ဆေး"],
  fields: [field("name"), field("age"), field("remarks", "SKIP")],
  groups: [],
});

const value = (fieldId: string, valueText: string | null = "၁၂") => ({ fieldId, valueText, state: "OK", isDitto: false });

describe("validateExtraction binds values only to listed Extract fields", () => {
  it("keeps values verbatim and bound to their field ids", () => {
    const out = validateExtraction(
      {
        contentState: "HAS_CONTENT",
        anchorsFound: [" ကာကွယ်ဆေး "],
        records: [{ recordIndex: 0, rowType: "DATA", struckThrough: false, pageIndex: 0, values: [value("name", "မောင်မောင်"), value("age", "1 1/2")] }],
      },
      template("FORM"),
      [0],
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.records[0]?.values.map((v) => [v.fieldId, v.valueText])).toEqual([
      ["name", "မောင်မောင်"],
      ["age", "1 1/2"],
    ]);
    expect(out.value.anchorsFound).toEqual(["ကာကွယ်ဆေး"]);
  });

  it("rejects a field id that isn't an Extract field of the template (unknown or Manual)", () => {
    const out = validateExtraction(
      { contentState: "HAS_CONTENT", records: [{ recordIndex: 0, pageIndex: 0, values: [value("name"), value("manual-field")] }] },
      template("FORM"),
      [0],
    );
    expect(out.ok).toBe(false);
  });

  it("drops values for Skip fields instead of writing them", () => {
    const out = validateExtraction(
      { contentState: "HAS_CONTENT", records: [{ recordIndex: 0, pageIndex: 0, values: [value("name"), value("remarks")] }] },
      template("TABLE"),
      [0],
    );
    expect(out.ok && out.value.records[0]?.values.map((v) => v.fieldId)).toEqual(["name"]);
  });

  it("rejects the same field twice in one record", () => {
    const out = validateExtraction(
      { contentState: "HAS_CONTENT", records: [{ recordIndex: 0, pageIndex: 0, values: [value("name", "a"), value("name", "b")] }] },
      template("TABLE"),
      [0],
    );
    expect(out.ok).toBe(false);
  });

  it("rejects a page that wasn't sent, several form records, and records on a blank page", () => {
    const rec = (pageIndex: number) => ({ recordIndex: 0, pageIndex, values: [value("name")] });
    expect(validateExtraction({ contentState: "HAS_CONTENT", records: [rec(3)] }, template("TABLE"), [0, 1]).ok).toBe(false);
    expect(validateExtraction({ contentState: "HAS_CONTENT", records: [rec(0), rec(0)] }, template("FORM"), [0]).ok).toBe(false);
    expect(validateExtraction({ contentState: "EMPTY", records: [rec(0)] }, template("TABLE"), [0]).ok).toBe(false);
  });

  it("accepts a blank page with no records", () => {
    const out = validateExtraction({ contentState: "EMPTY", anchorsFound: [], records: [] }, template("FORM"), [0]);
    expect(out).toEqual({ ok: true, value: { contentState: "EMPTY", anchorsFound: [], records: [] } });
  });
});
