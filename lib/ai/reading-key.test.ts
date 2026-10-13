import { describe, expect, it } from "vitest";

import { buildTemplateSnapshot } from "@/lib/ai/snapshot";
import type { FieldView } from "@/lib/templates/views";

import { readingKey } from "./reading-key";

/**
 * The fingerprint decides which documents are flagged `fields changed since read` (decision 88). One
 * that misses an edit hides a stale reading silently; one that moves on an edit the AI never sees
 * flags a whole template for nothing.
 */

type Template = Parameters<typeof buildTemplateSnapshot>[0];

const template: Template = { id: "t1", kind: "TABLE", languageHint: "my", instructions: "One row per patient.", anchors: ["Register"] };

function field(id: string, position: string, over: Partial<FieldView> = {}): FieldView {
  return {
    id,
    labelSource: `Name ${id}`,
    labelMeaning: null,
    dataType: "TEXT",
    mode: "EXTRACT",
    note: null,
    choices: [],
    markSymbols: [],
    isSequence: false,
    position,
    ...over,
  };
}

const fields: FieldView[] = [
  field("seq", "a0", { dataType: "NUMBER", isSequence: true }),
  field("name", "a1", { labelMeaning: "Name" }),
  field("sex", "a2", { dataType: "CHOICE", choices: ["M", "F"] }),
  field("tick", "a3", { dataType: "MARK", markSymbols: ["✓", "✗"] }),
  field("skipped", "a4", { mode: "SKIP" }),
  field("typed", "a5", { mode: "MANUAL" }),
];

const key = (t: Template, f: FieldView[]) => readingKey(buildTemplateSnapshot(t, f));
const base = key(template, fields);
const withField = (id: string, over: Partial<FieldView>) => fields.map((f) => (f.id === id ? { ...f, ...over } : f));

describe("readingKey", () => {
  it.each<[string, Template, FieldView[]]>([
    ["a rename", template, withField("name", { labelSource: "Patient name" })],
    ["the English meaning", template, withField("name", { labelMeaning: "Full name" })],
    ["the type", template, withField("name", { dataType: "DATE" })],
    ["the note", template, withField("name", { note: "Copy titles too." })],
    ["the choices", template, withField("sex", { choices: ["M", "F", "?"] })],
    ["the mark symbols", template, withField("tick", { markSymbols: ["✓"] })],
    ["the order of the mark symbols", template, withField("tick", { markSymbols: ["✗", "✓"] })],
    ["Extract to Skip", template, withField("name", { mode: "SKIP" })],
    ["Skip to Extract", template, withField("skipped", { mode: "EXTRACT" })],
    ["a field moved into Manual", template, withField("name", { mode: "MANUAL" })],
    ["a field moved out of Manual", template, withField("typed", { mode: "EXTRACT" })],
    ["a field added", template, [...fields, field("new", "a6")]],
    ["a field deleted", template, fields.filter((f) => f.id !== "name")],
    ["a field deleted and made again", template, withField("name", { id: "name2" })],
    ["a reorder", template, withField("name", { position: "a35" })],
    ["a skipped field reordered", template, withField("skipped", { position: "a05" })],
    ["the sequence field", template, withField("seq", { isSequence: false })],
    ["the language hint", { ...template, languageHint: "en" }, fields],
    ["the instructions", { ...template, instructions: "One row per visit." }, fields],
  ])("changes with %s", (_name, t, f) => {
    expect(key(t, f)).not.toBe(base);
  });

  it.each<[string, Template, FieldView[]]>([
    ["a Manual field renamed", template, withField("typed", { labelSource: "Typed in", note: "by hand" })],
    ["a Manual field retyped", template, withField("typed", { dataType: "MARK", markSymbols: ["✓"] })],
    ["a Manual field reordered", template, withField("typed", { position: "a15" })],
    ["a Manual field added", template, [...fields, field("typed2", "a6", { mode: "MANUAL" })]],
    ["a Manual field deleted", template, fields.filter((f) => f.id !== "typed")],
    ["the anchors", { ...template, anchors: ["Register", "Township"] }, fields],
    ["an empty note saved as blank", template, withField("name", { note: " " })],
    ["position keys respaced in the same order", template, fields.map((f, i) => ({ ...f, position: `b${i}` }))],
  ])("stays the same with %s", (_name, t, f) => {
    expect(key(t, f)).toBe(base);
  });

  it("comes back when an edit is undone", () => {
    const edited = withField("name", { note: "Copy titles too." });
    expect(key(template, edited)).not.toBe(base);
    expect(key(template, withField("name", { note: null }))).toBe(base);
    expect(key({ ...template }, [...fields].reverse())).toBe(base);
  });
});
