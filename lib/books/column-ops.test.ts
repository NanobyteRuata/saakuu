import { generateNKeysBetween } from "fractional-indexing";
import { describe, expect, it } from "vitest";

import { classifyColumnChange, simulateColumnOps, type ColumnState } from "./column-ops";

function columns(...keys: string[]): ColumnState[] {
  const positions = generateNKeysBetween(null, null, keys.length);
  return keys.map((key, i) => ({
    id: `c_${key}`,
    key,
    label: key.toUpperCase(),
    dataType: "TEXT",
    enumValues: [],
    isRequired: false,
    position: positions[i] ?? "",
  }));
}

describe("simulateColumnOps", () => {
  const cur = columns("a", "b", "c", "d");

  it("moves a column by writing exactly one position", () => {
    const sim = simulateColumnOps(cur, [{ kind: "move", id: "c_d", afterId: null }]);
    expect(sim.finalColumns.map((c) => c.key)).toEqual(["d", "a", "b", "c"]);
    expect(sim.positionWrites.map((w) => w.id)).toEqual(["c_d"]);
    expect(classifyColumnChange(cur, sim).severity).toBe("SAFE");
  });

  it("treats deletes as destructive and frees the key for reuse", () => {
    const sim = simulateColumnOps(cur, [
      { kind: "delete", id: "c_a" },
      { kind: "add", tempId: "tmp_a", afterId: null, key: "a", label: "A", dataType: "TEXT", enumValues: [], isRequired: false },
    ]);
    expect(sim.deletes.map((c) => c.id)).toEqual(["c_a"]);
    expect(sim.finalColumns.map((c) => c.id)).toEqual(["tmp_a", "c_b", "c_c", "c_d"]);
    expect(classifyColumnChange(cur, sim).severity).toBe("DESTRUCTIVE");
  });

  it("rejects duplicate keys and deleting every column", () => {
    expect(() => simulateColumnOps(cur, [{ kind: "update", id: "c_b", key: "a" }])).toThrow(/both use the key "a"/);
    expect(() => simulateColumnOps(columns("a"), [{ kind: "delete", id: "c_a" }])).toThrow(/at least one column/);
  });
});
