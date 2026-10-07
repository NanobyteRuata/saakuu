import { describe, expect, it } from "vitest";

import { duplicateNames, orderFields, shortName, splitName, type ListField } from "./field-list";

function field(id: string, labelSource: string, position: string): ListField {
  return { id, labelSource, labelMeaning: null, position, dataType: "TEXT", mode: "EXTRACT" };
}

describe("orderFields", () => {
  it("is paper order by position, ties broken by id", () => {
    const source = orderFields([field("c", "C", "a1"), field("b", "B", "a0"), field("a", "A", "a1"), field("d", "D", "Zz")]);
    expect(source.list.map((f) => f.id)).toEqual(["d", "b", "a", "c"]);
    expect(source.byId.get("a")?.labelSource).toBe("A");
  });
});

describe("splitName", () => {
  it("gives the AI the header levels, each with its own meaning", () => {
    expect(splitName("RDT စစ်ဆေး › Positive › A", "RDT Test › Positive › A")).toEqual([
      { label: "RDT စစ်ဆေး", meaning: "RDT Test" },
      { label: "Positive", meaning: null },
      { label: "A", meaning: null },
    ]);
  });

  it("is one level for a name with no header", () => {
    expect(splitName("အမည်", "Name")).toEqual([{ label: "အမည်", meaning: "Name" }]);
    expect(splitName("No.", null)).toEqual([{ label: "No.", meaning: null }]);
  });

  it("puts a meaning with a different number of levels on the field itself", () => {
    expect(splitName("၁ ရက်နေ့ › ကိုယ်ပူချိန်", "Temperature")).toEqual([
      { label: "၁ ရက်နေ့", meaning: null },
      { label: "ကိုယ်ပူချိန်", meaning: "Temperature" },
    ]);
  });
});

describe("shortName", () => {
  it("is the last level of the meaning, or of the name", () => {
    expect(shortName({ labelSource: "လိင် › ကျား", labelMeaning: "Sex › M" })).toBe("M");
    expect(shortName({ labelSource: "RDT Test › Positive › A", labelMeaning: null })).toBe("A");
  });
});

describe("duplicateNames", () => {
  it("finds fields that share a name, ignoring case and spaces around it", () => {
    const dup = duplicateNames([
      { id: "a", labelSource: "Day 1 › Temp" },
      { id: "b", labelSource: "Day 3 › Temp" },
      { id: "c", labelSource: "Weight" },
      { id: "d", labelSource: " weight " },
    ]);
    expect([...dup].sort()).toEqual(["c", "d"]);
  });
});
