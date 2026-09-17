import { z } from "zod";

import { coerceToColumn } from "@/lib/transform/coerce";
import type { BookSettings, TransformColumn, ValueState } from "@/lib/transform/types";

/**
 * What a person's change to a cell writes (docs/02 invariants 3–4). Pure, so the rules that protect human
 * work are tested without a database:
 * - An edit stores the value in the column's canonical form when it reads as that type (`12/3/2024` →
 *   `2024-03-12`), else exactly as typed, where validation flags it. It never touches `extractedValue`.
 * - Revert puts back the extracted value and its state.
 * - Undo puts back what a logged change replaced, only while the cell still holds what that change wrote.
 */

export const VALUE_STATES = ["OK", "ILLEGIBLE", "EMPTY", "DASH", "NOT_APPLICABLE"] as const;

export type CellFlags = { state: ValueState; isEdited: boolean; disagreement: boolean };

export type CellSnapshot = CellFlags & {
  currentValue: string | null;
  extractedValue: string | null;
  extractedState: ValueState;
};

export type CellWrite = CellFlags & { currentValue: string | null };

/** Stored on `CellEdit.flags`: what the change replaced and what it wrote, besides the values. */
export const editFlagsSchema = z.object({
  before: z.object({ state: z.enum(VALUE_STATES), isEdited: z.boolean(), disagreement: z.boolean() }),
  after: z.object({ state: z.enum(VALUE_STATES), isEdited: z.boolean(), disagreement: z.boolean() }),
});

export type EditFlags = z.infer<typeof editFlagsSchema>;

export type ChangePlan = { kind: "noop" } | { kind: "write"; write: CellWrite; flags: EditFlags; previousValue: string | null };

export type EditInput = { value: string | null; state?: ValueState };

function flagsOf(c: CellFlags): CellFlags {
  return { state: c.state, isEdited: c.isEdited, disagreement: c.disagreement };
}

function plan(cell: CellSnapshot, write: CellWrite): ChangePlan {
  if (
    write.currentValue === cell.currentValue &&
    write.state === cell.state &&
    write.isEdited === cell.isEdited &&
    write.disagreement === cell.disagreement
  ) {
    return { kind: "noop" };
  }
  return { kind: "write", write, flags: { before: flagsOf(cell), after: flagsOf(write) }, previousValue: cell.currentValue };
}

/** The value as stored: blank is empty; a value that reads as the column's type in its canonical form. */
export function canonicalValue(input: EditInput, column: TransformColumn, book: BookSettings): { value: string | null; state: ValueState } {
  const state = input.state ?? "OK";
  if (state !== "OK") return { value: null, state };
  if (input.value === null || input.value.trim() === "") return { value: null, state: "EMPTY" };
  const coerced = coerceToColumn(input.value, column, book);
  const valid = !coerced.issues.some((i) => i.severity === "ERROR");
  return { value: valid ? coerced.text : input.value, state: "OK" };
}

export function planEdit(cell: CellSnapshot, input: EditInput, column: TransformColumn, book: BookSettings): ChangePlan {
  const { value, state } = canonicalValue(input, column, book);
  // Typing what is already there changes nothing: it doesn't make an extracted value "edited".
  if (value === cell.currentValue && state === cell.state) return { kind: "noop" };
  // A person deciding the value settles any disagreement with the extraction.
  return plan(cell, { currentValue: value, state, isEdited: true, disagreement: false });
}

export function planRevert(cell: CellSnapshot): ChangePlan {
  return plan(cell, { currentValue: cell.extractedValue, state: cell.extractedState, isEdited: false, disagreement: false });
}

/** Keep my value: the disagreement is settled without changing anything else. */
export function planKeepMine(cell: CellSnapshot): ChangePlan {
  return plan(cell, { currentValue: cell.currentValue, state: cell.state, isEdited: cell.isEdited, disagreement: false });
}

export type LoggedChange = { previousValue: string | null; newValue: string | null; flags: EditFlags };

export type UndoPlan = ChangePlan | { kind: "refused"; reason: string };

export function planUndo(cell: CellSnapshot, change: LoggedChange): UndoPlan {
  const { after, before } = change.flags;
  const unchanged = cell.currentValue === change.newValue && cell.state === after.state && cell.isEdited === after.isEdited;
  if (!unchanged) return { kind: "refused", reason: "This cell changed after that edit, so it can't be undone. Edit the cell instead." };
  return plan(cell, { currentValue: change.previousValue, state: before.state, isEdited: before.isEdited, disagreement: before.disagreement });
}

/** An edit session's saves collapse into one log entry: the entry keeps what the session first replaced. */
export function coalesce(first: LoggedChange, next: Extract<ChangePlan, { kind: "write" }>): LoggedChange {
  return { previousValue: first.previousValue, newValue: next.write.currentValue, flags: { before: first.flags.before, after: next.flags.after } };
}
