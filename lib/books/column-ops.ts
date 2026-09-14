import { generateKeyBetween } from "fractional-indexing";

import { AppError } from "@/lib/errors";

import { columnShapeProblem, MAX_COLUMNS, type ColumnOp, type ColumnType } from "./schemas";

/**
 * Pure simulation of an output-column change. The preview and the apply both run this over
 * the current columns, so validation and write plans can never drift apart.
 */

export type ColumnState = {
  id: string;
  key: string;
  label: string;
  dataType: ColumnType;
  enumValues: string[];
  isRequired: boolean;
  position: string;
};

type EditableField = "key" | "label" | "dataType" | "enumValues" | "isRequired";
export type ColumnUpdate = { id: string; data: Partial<Pick<ColumnState, EditableField>> };

export type ColumnSimulation = {
  /** Live columns after the change, in order. New columns carry their tempId as `id`. */
  finalColumns: Array<ColumnState & { isNew: boolean }>;
  creates: Array<Omit<ColumnState, "id"> & { tempId: string }>;
  /** Field changes on existing columns; only fields whose value actually changed. */
  updates: ColumnUpdate[];
  /** Existing columns that moved. A move writes exactly one row. */
  positionWrites: Array<{ id: string; position: string }>;
  /** Existing columns being deleted, as they were before the change. */
  deletes: ColumnState[];
};

export type ChangeSeverity = "SAFE" | "ADDITIVE" | "DESTRUCTIVE";

type Entry = { state: ColumnState; isNew: boolean; moved: boolean; original: ColumnState | null };

function invalid(message: string): never {
  throw new AppError("VALIDATION", message);
}

function sameValues(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export function sortByPosition<T extends { position: string; id: string }>(columns: T[]): T[] {
  // Fractional-index keys compare by code unit, not locale.
  return [...columns].sort((a, b) =>
    a.position < b.position ? -1 : a.position > b.position ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
}

export function simulateColumnOps(current: ColumnState[], ops: ColumnOp[]): ColumnSimulation {
  const list: Entry[] = sortByPosition(current).map((c) => ({
    state: { ...c, enumValues: [...c.enumValues] },
    isNew: false,
    moved: false,
    original: c,
  }));
  const deleted = new Map<string, Entry>();

  const indexOf = (id: string) => list.findIndex((e) => e.state.id === id);
  const describe = (id: string) => {
    const gone = deleted.get(id);
    return gone
      ? `"${gone.state.label}" is deleted earlier in this change, so it can't be changed or used as a position.`
      : "One of the columns in this change no longer exists. Reload and try again.";
  };
  const find = (id: string): Entry => {
    const entry = list[indexOf(id)];
    return entry ?? invalid(describe(id));
  };
  const insertAfter = (entry: Entry, afterId: string | null) => {
    let at = 0;
    if (afterId !== null) {
      if (afterId === entry.state.id) invalid(`"${entry.state.label}" can't be positioned after itself.`);
      const idx = indexOf(afterId);
      if (idx < 0) invalid(describe(afterId));
      at = idx + 1;
    }
    const prev = list[at - 1];
    const next = list[at];
    entry.state.position = generateKeyBetween(prev?.state.position ?? null, next?.state.position ?? null);
    list.splice(at, 0, entry);
  };

  for (const op of ops) {
    switch (op.kind) {
      case "add": {
        if (indexOf(op.tempId) >= 0 || deleted.has(op.tempId)) invalid("Two new columns share a temporary id. Reload and try again.");
        const entry: Entry = {
          state: {
            id: op.tempId,
            key: op.key,
            label: op.label,
            dataType: op.dataType,
            enumValues: [...op.enumValues],
            isRequired: op.isRequired,
            position: "",
          },
          isNew: true,
          moved: false,
          original: null,
        };
        insertAfter(entry, op.afterId);
        break;
      }
      case "update": {
        const entry = find(op.id);
        const s = entry.state;
        if (op.key !== undefined) s.key = op.key;
        if (op.label !== undefined) s.label = op.label;
        if (op.isRequired !== undefined) s.isRequired = op.isRequired;
        if (op.dataType !== undefined) {
          s.dataType = op.dataType;
          if (op.dataType !== "ENUM" && op.enumValues === undefined) s.enumValues = [];
        }
        if (op.enumValues !== undefined) s.enumValues = [...op.enumValues];
        break;
      }
      case "delete": {
        const idx = indexOf(op.id);
        const entry = list[idx];
        if (!entry) invalid(describe(op.id));
        list.splice(idx, 1);
        deleted.set(op.id, entry);
        break;
      }
      case "move": {
        const idx = indexOf(op.id);
        const entry = list[idx];
        if (!entry) invalid(describe(op.id));
        list.splice(idx, 1);
        insertAfter(entry, op.afterId);
        entry.moved = true;
        break;
      }
    }
  }

  if (list.length === 0) invalid("A book needs at least one column.");
  if (list.length > MAX_COLUMNS) invalid(`A book can have up to ${MAX_COLUMNS} columns.`);
  const byKey = new Map<string, string>();
  for (const { state } of list) {
    const other = byKey.get(state.key);
    if (other !== undefined) invalid(`"${other}" and "${state.label}" both use the key "${state.key}". Keys must be unique.`);
    byKey.set(state.key, state.label);
    const problem = columnShapeProblem(state);
    if (problem) invalid(problem);
  }

  const updates: ColumnUpdate[] = [];
  const positionWrites: ColumnSimulation["positionWrites"] = [];
  for (const { state, original, moved } of list) {
    if (!original) continue;
    const data: ColumnUpdate["data"] = {};
    if (state.key !== original.key) data.key = state.key;
    if (state.label !== original.label) data.label = state.label;
    if (state.dataType !== original.dataType) data.dataType = state.dataType;
    if (!sameValues(state.enumValues, original.enumValues)) data.enumValues = state.enumValues;
    if (state.isRequired !== original.isRequired) data.isRequired = state.isRequired;
    if (Object.keys(data).length > 0) updates.push({ id: state.id, data });
    if (moved && state.position !== original.position) positionWrites.push({ id: state.id, position: state.position });
  }

  return {
    finalColumns: list.map((e) => ({ ...e.state, isNew: e.isNew })),
    creates: list
      .filter((e) => e.isNew)
      .map(({ state }) => ({
        tempId: state.id,
        key: state.key,
        label: state.label,
        dataType: state.dataType,
        enumValues: state.enumValues,
        isRequired: state.isRequired,
        position: state.position,
      })),
    updates,
    positionWrites,
    deletes: [...deleted.values()].flatMap((e) => (e.original ? [e.original] : [])),
  };
}

/**
 * Classifies the net effect of a change (docs/01 §8). Label, key, required, order and added
 * list values are SAFE; new columns are ADDITIVE; deletions, list values removed, and type
 * changes other than to TEXT are DESTRUCTIVE because existing cells may be lost or fail coercion.
 */
export function classifyColumnChange(
  current: ColumnState[],
  sim: ColumnSimulation,
): { severity: ChangeSeverity; deletedIds: string[]; retypedIds: string[] } {
  const before = new Map(current.map((c) => [c.id, c]));
  const retypedIds: string[] = [];
  for (const { id, data } of sim.updates) {
    const was = before.get(id);
    if (!was) continue;
    const typeChanged = data.dataType !== undefined && data.dataType !== "TEXT";
    const valuesRemoved =
      data.dataType === undefined &&
      was.dataType === "ENUM" &&
      data.enumValues !== undefined &&
      was.enumValues.some((v) => !data.enumValues?.includes(v));
    if (typeChanged || valuesRemoved) retypedIds.push(id);
  }
  const deletedIds = sim.deletes.map((c) => c.id);
  const severity: ChangeSeverity =
    deletedIds.length > 0 || retypedIds.length > 0 ? "DESTRUCTIVE" : sim.creates.length > 0 ? "ADDITIVE" : "SAFE";
  return { severity, deletedIds, retypedIds };
}

/** The key a soft-deleted column is parked under, freeing its live key for reuse. */
export function deletedColumnKey(key: string, id: string): string {
  return `${key}~del~${id}`;
}
