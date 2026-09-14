import type { ColumnOp, ColumnType } from "./schemas";

/** A column as held by the editor. `uid` is the id for existing columns, a `tmp_` id for new ones. */
export type EditorColumn = {
  uid: string;
  id: string | null;
  key: string;
  label: string;
  dataType: ColumnType;
  enumValues: string[];
  isRequired: boolean;
};

type OriginalColumn = Omit<EditorColumn, "uid" | "id"> & { id: string };

function sameValues(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Indices (into `seq`) of one longest strictly increasing subsequence. O(n log n). */
function longestIncreasing(seq: number[]): Set<number> {
  const tails: number[] = [];
  const prev: number[] = new Array<number>(seq.length).fill(-1);
  for (let i = 0; i < seq.length; i++) {
    const v = seq[i] ?? 0;
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((seq[tails[mid] ?? 0] ?? 0) < v) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1] ?? -1;
    tails[lo] = i;
  }
  const keep = new Set<number>();
  let k = tails.at(-1) ?? -1;
  while (k >= 0) {
    keep.add(k);
    k = prev[k] ?? -1;
  }
  return keep;
}

/**
 * Turns the editor's working list into the smallest op diff against the saved columns:
 * deletes, changed fields only, adds, and moves only for columns outside the longest run
 * that kept its relative order.
 */
export function diffColumns(original: OriginalColumn[], working: EditorColumn[]): ColumnOp[] {
  const originalIndex = new Map(original.map((c, i) => [c.id, i]));
  const kept = new Set(working.flatMap((c) => (c.id ? [c.id] : [])));

  const ops: ColumnOp[] = original.filter((c) => !kept.has(c.id)).map((c) => ({ kind: "delete", id: c.id }));

  for (const col of working) {
    if (!col.id) continue;
    const was = original[originalIndex.get(col.id) ?? -1];
    if (!was) continue;
    const op: Extract<ColumnOp, { kind: "update" }> = { kind: "update", id: col.id };
    if (col.key !== was.key) op.key = col.key;
    if (col.label !== was.label) op.label = col.label;
    if (col.dataType !== was.dataType) op.dataType = col.dataType;
    if (!sameValues(col.enumValues, was.enumValues)) op.enumValues = col.enumValues;
    if (col.isRequired !== was.isRequired) op.isRequired = col.isRequired;
    if (Object.keys(op).length > 2) ops.push(op);
  }

  const survivors = working.flatMap((c, i) => (c.id ? [{ i, orig: originalIndex.get(c.id) ?? -1 }] : []));
  const lis = longestIncreasing(survivors.map((s) => s.orig));
  const stays = new Set([...lis].flatMap((k) => (survivors[k] ? [survivors[k].i] : [])));

  let afterId: string | null = null;
  working.forEach((col, i) => {
    if (!col.id) {
      ops.push({
        kind: "add",
        tempId: col.uid,
        afterId,
        key: col.key,
        label: col.label,
        dataType: col.dataType,
        enumValues: col.enumValues,
        isRequired: col.isRequired,
      });
    } else if (!stays.has(i)) {
      ops.push({ kind: "move", id: col.id, afterId });
    }
    afterId = col.id ?? col.uid;
  });

  return ops;
}
