import { describe, expect, it } from "vitest";

import type { BookSettings, TransformColumn } from "@/lib/transform/types";

import { coalesce, planEdit, planRevert, planUndo, type CellSnapshot, type LoggedChange } from "./edits";

const book: BookSettings = { numeralSystem: "AUTO", dateEra: "GREGORIAN" };
const column = (dataType: TransformColumn["dataType"]): TransformColumn => ({ id: "c", key: "c", label: "C", dataType, enumValues: [], isRequired: false });

const extracted: CellSnapshot = {
  currentValue: null,
  state: "ILLEGIBLE",
  extractedValue: null,
  extractedState: "ILLEGIBLE",
  isEdited: false,
  disagreement: false,
};

function write(p: ReturnType<typeof planUndo>) {
  if (p.kind !== "write") throw new Error(`expected a write, got ${p.kind}`);
  return p;
}

describe("cell edits", () => {
  it("stores a typed value in the column's canonical form and never touches the extraction", () => {
    const p = write(planEdit(extracted, { value: "12/3/2024" }, column("DATE"), book));
    expect(p.write).toEqual({ currentValue: "2024-03-12", state: "OK", isEdited: true, disagreement: false });
    expect(p.write).not.toHaveProperty("extractedValue");
    expect(write(planEdit(extracted, { value: "၄၂" }, column("INTEGER"), book)).write.currentValue).toBe("42");
  });

  it("keeps a value that doesn't read as the column type exactly as typed", () => {
    expect(write(planEdit(extracted, { value: "about 40" }, column("INTEGER"), book)).write.currentValue).toBe("about 40");
  });

  it("writes nothing when the value is unchanged", () => {
    const cell: CellSnapshot = { ...extracted, currentValue: "7", state: "OK", extractedValue: "7", extractedState: "OK" };
    expect(planEdit(cell, { value: "7" }, column("INTEGER"), book)).toEqual({ kind: "noop" });
  });

  it("revert restores the extracted value and its state", () => {
    const edited = { ...extracted, ...write(planEdit(extracted, { value: "42" }, column("INTEGER"), book)).write };
    expect(write(planRevert({ ...edited, disagreement: true })).write).toEqual({ currentValue: null, state: "ILLEGIBLE", isEdited: false, disagreement: false });
    expect(planRevert(extracted)).toEqual({ kind: "noop" });
  });

  it("undo restores what an edit replaced, and refuses once the cell changed again", () => {
    const first = write(planEdit(extracted, { value: "4" }, column("TEXT"), book));
    const afterFirst = { ...extracted, ...first.write };
    const second = write(planEdit(afterFirst, { value: "42" }, column("TEXT"), book));
    const session: LoggedChange = coalesce({ previousValue: first.previousValue, newValue: first.write.currentValue, flags: first.flags }, second);
    const afterSession = { ...afterFirst, ...second.write };

    expect(write(planUndo(afterSession, session)).write).toEqual({ currentValue: null, state: "ILLEGIBLE", isEdited: false, disagreement: false });
    expect(planUndo({ ...afterSession, currentValue: "43" }, session).kind).toBe("refused");
  });
});
