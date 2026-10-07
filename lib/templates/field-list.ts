import { generateKeyBetween } from "fractional-indexing";

import type { FieldMode, FieldType } from "./schemas";

/**
 * The source layer as one list (docs/02 invariants 9–12, decision 84). Pure and client-safe: the
 * editor, the services, the prompt builder and review labels all read fields through here.
 *
 * A field is one box on the paper giving one value: a column of a table or an answer box of a form.
 * Fields have one paper order per template and nothing groups them. The header above a field is the
 * front of its name, levels joined with " › ": `RDT Test › Positive › A`.
 */

type Positioned = { id: string; position: string };

/** Fractional keys compare by code unit, not locale; ties broken by id. */
export function compareSiblings(a: Positioned, b: Positioned): number {
  return a.position < b.position ? -1 : a.position > b.position ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export type ListField = {
  id: string;
  labelSource: string;
  labelMeaning: string | null;
  position: string;
  dataType: FieldType;
  mode: FieldMode;
};

export type FieldList<F extends ListField = ListField> = {
  /** Fields in paper order. */
  list: F[];
  byId: Map<string, F>;
};

export function orderFields<F extends ListField>(fields: F[]): FieldList<F> {
  const list = [...fields].sort(compareSiblings);
  return { list, byId: new Map(list.map((f) => [f.id, f])) };
}

/** Between the levels of a name, header first. */
export const NAME_SEPARATOR = " › ";

export function formatPath(labels: string[]): string {
  return labels.join(NAME_SEPARATOR);
}

function levels(name: string): string[] {
  const parts = name.split(NAME_SEPARATOR).map((p) => p.trim()).filter((p) => p !== "");
  return parts.length > 0 ? parts : [name];
}

/**
 * A name as the header levels the AI is shown, from the top header down to the field itself. The
 * meaning is paired level by level when it has as many levels as the name; a level whose meaning is
 * just its label again has none. A meaning with a different number of levels belongs to the field.
 */
export function splitName(name: string, meaning: string | null): { label: string; meaning: string | null }[] {
  const labels = levels(name);
  const meanings = meaning === null ? [] : levels(meaning);
  if (meanings.length === labels.length) {
    return labels.map((label, i) => ({ label, meaning: meanings[i] === label ? null : (meanings[i] ?? null) }));
  }
  return labels.map((label, i) => ({ label, meaning: i === labels.length - 1 ? meaning : null }));
}

/** The field's own words without the header in front: the last level of its meaning, or of its name. */
export function shortName(field: { labelSource: string; labelMeaning: string | null }): string {
  return levels(field.labelMeaning ?? field.labelSource).at(-1) ?? field.labelSource;
}

/** Two names are the same when they read the same: trimmed, Unicode-normalised, case ignored. */
export function nameKey(name: string): string {
  return name.trim().normalize("NFC").toLowerCase();
}

/** Ids of fields whose name another field in the list also has. They can't be told apart where names are listed. */
export function duplicateNames(fields: { id: string; labelSource: string }[]): Set<string> {
  const byName = new Map<string, string[]>();
  for (const f of fields) {
    const key = nameKey(f.labelSource);
    byName.set(key, [...(byName.get(key) ?? []), f.id]);
  }
  return new Set([...byName.values()].filter((ids) => ids.length > 1).flat());
}

/** A tick field a `From ticks` mapping can read as an option: one the AI reads or you type (not Skip). */
export function isTickOption(field: { dataType: FieldType; mode: FieldMode }): boolean {
  return field.dataType === "MARK" && field.mode !== "SKIP";
}

/** Key for an optimistic client-side move after `afterId` (null = first), or null when only the server can decide (e.g. equal neighbour keys). */
export function localPositionAfter(list: Positioned[], afterId: string | null, movingId: string): string | null {
  const others = list.filter((s) => s.id !== movingId).sort(compareSiblings);
  const at = afterId === null ? 0 : others.findIndex((s) => s.id === afterId) + 1;
  if (afterId !== null && at === 0) return null;
  try {
    return generateKeyBetween(others[at - 1]?.position ?? null, others[at]?.position ?? null);
  } catch {
    return null;
  }
}
