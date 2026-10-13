import { createHash } from "node:crypto";

import { stableStringify } from "@/lib/impact";

import type { TemplateSnapshot } from "./provider";

/** A document read before Phase 28: it counts as read with whatever its template said on release day. */
export const READING_KEY_START = "start";
/** A document whose pages were read under different fingerprints. Equal to no template's, so it always flags. */
export const READING_KEY_MIXED = "mixed";

const blankIsNone = (s: string | null): string | null => (s === null || s.trim() === "" ? null : s);

/**
 * The fingerprint of what the AI is told about a template (decision 88): its kind, language hint,
 * instructions and the field list in the order sent. Built from the snapshot, the one place that
 * decides what is sent, so the flag cannot drift from the prompt. A document read under another
 * fingerprint was read before a field change.
 *
 * Left out on purpose: the template's id, its anchors (sent, but only to score the template match)
 * and `groups` (always empty). Field ids stay in: a field deleted and made again sends the same
 * words, but its values hang on the deleted field, so the page does need reading again.
 */
export function readingKey(snapshot: TemplateSnapshot): string {
  const told = {
    kind: snapshot.kind,
    languageHint: blankIsNone(snapshot.languageHint),
    instructions: blankIsNone(snapshot.instructions),
    fields: snapshot.fields.map((f) => ({
      id: f.id,
      path: f.path.map((p) => [p.label, blankIsNone(p.meaning)]),
      dataType: f.dataType,
      mode: f.mode,
      note: blankIsNone(f.note),
      choices: f.choices,
      // As a list: the order of the symbols is the order they are sent in.
      markSymbols: f.markSymbols ? Object.keys(f.markSymbols) : [],
      isSequence: f.isSequence,
    })),
  };
  return createHash("sha256").update(stableStringify(told)).digest("hex");
}
