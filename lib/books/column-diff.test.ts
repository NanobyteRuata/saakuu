import { generateNKeysBetween } from "fractional-indexing";
import { describe, expect, it } from "vitest";

import { diffColumns, type EditorColumn } from "./column-diff";
import { simulateColumnOps, type ColumnState } from "./column-ops";

function saved(n: number): ColumnState[] {
  return generateNKeysBetween(null, null, n).map((position, i) => ({
    id: `c${i}`,
    key: `k${i}`,
    label: `Column ${i}`,
    dataType: "TEXT",
    enumValues: [],
    isRequired: false,
    position,
  }));
}

/** Small deterministic PRNG so the property test is reproducible. */
function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

describe("diffColumns", () => {
  it("round-trips arbitrary editor changes through the server simulation", () => {
    const random = rng(42);
    for (let iteration = 0; iteration < 300; iteration++) {
      const cols = saved(1 + Math.floor(random() * 8));
      let working: EditorColumn[] = cols
        .map((c) => ({ ...c, uid: c.id }))
        .filter(() => random() > 0.25)
        .map((c) => (random() < 0.3 ? { ...c, label: `${c.label}!` } : c));
      for (let i = 0; i < Math.floor(random() * 3); i++) {
        const at = Math.floor(random() * (working.length + 1));
        working.splice(at, 0, { uid: `tmp_${iteration}_${i}`, id: null, key: `new_${i}`, label: `New ${i}`, dataType: "TEXT", enumValues: [], isRequired: false });
      }
      if (working.length === 0) continue;
      working = [...working].sort(() => random() - 0.5);

      const sim = simulateColumnOps(cols, diffColumns(cols, working));
      expect(sim.finalColumns.map((c) => c.id)).toEqual(working.map((c) => c.id ?? c.uid));
      expect(sim.finalColumns.map((c) => c.label)).toEqual(working.map((c) => c.label));
    }
  });
});
