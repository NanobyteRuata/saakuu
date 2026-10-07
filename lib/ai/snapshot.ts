import { orderFields, splitName } from "@/lib/templates/field-list";
import type { TemplateKind } from "@/lib/templates/schemas";
import type { FieldView } from "@/lib/templates/views";

import type { SnapshotField, TemplateSnapshot } from "./provider";

/**
 * The template as the model sees it (docs/03 §3 item 9): EXTRACT and SKIP fields in paper order.
 * MANUAL fields are left out. A field's name is split back into its header levels, so `path` reads
 * from the top header down to the field exactly as it did when headers were rows of their own.
 * `groups` is always empty since decision 84; the key stays because the frozen prompts read it.
 * Pure: built from the same rows the editor uses, through `lib/templates/field-list.ts`.
 */
export function buildTemplateSnapshot(
  template: { id: string; kind: TemplateKind; languageHint: string | null; instructions: string | null; anchors: string[] },
  fields: FieldView[],
): TemplateSnapshot {
  const snapshotFields: SnapshotField[] = [];
  for (const f of orderFields(fields).list) {
    if (f.mode === "MANUAL") continue;
    snapshotFields.push({
      id: f.id,
      path: splitName(f.labelSource, f.labelMeaning),
      dataType: f.dataType,
      mode: f.mode,
      note: f.note,
      choices: f.choices,
      markSymbols: f.markSymbols,
      isSequence: template.kind === "TABLE" && f.isSequence,
    });
  }
  return {
    id: template.id,
    kind: template.kind,
    languageHint: template.languageHint,
    instructions: template.instructions,
    anchors: template.anchors,
    fields: snapshotFields,
    groups: [],
  };
}
