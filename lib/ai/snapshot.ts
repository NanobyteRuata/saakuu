import { ancestorsFrom, buildTree, flattenTree, selectionOptions } from "@/lib/templates/tree";
import type { TemplateKind } from "@/lib/templates/schemas";
import type { FieldView, GroupView } from "@/lib/templates/views";

import type { PathLabel, SnapshotField, SnapshotGroup, TemplateSnapshot } from "./provider";

/**
 * The template as the model sees it (docs/03 §3 item 9): EXTRACT and SKIP fields in paper order with
 * their header paths, plus the groups that carry a note or a selection. MANUAL fields are left out.
 * Pure: built from the same flat rows the editor uses, through `lib/templates/tree.ts`.
 */
export function buildTemplateSnapshot(
  template: { id: string; kind: TemplateKind; languageHint: string | null; instructions: string | null; anchors: string[] },
  groups: GroupView[],
  fields: FieldView[],
): TemplateSnapshot {
  const tree = buildTree(groups, fields);
  const label = (x: { labelSource: string; labelMeaning: string | null }): PathLabel => ({ label: x.labelSource, meaning: x.labelMeaning });
  const above = (parentId: string | null) =>
    ancestorsFrom(tree, parentId)
      .reverse()
      .map((g) => label(g.group));

  const snapshotFields: SnapshotField[] = [];
  const snapshotGroups: SnapshotGroup[] = [];
  for (const node of flattenTree(tree)) {
    if (node.kind === "group") {
      const g = node.group;
      if (g.note === null && g.selection === "NONE") continue;
      snapshotGroups.push({
        id: g.id,
        path: [...above(node.parentId), label(g)],
        note: g.note,
        selection: g.selection,
        optionFieldIds: g.selection === "NONE" ? [] : selectionOptions(node).filter((f) => f.mode === "EXTRACT").map((f) => f.id),
      });
      continue;
    }
    const f = node.field;
    if (f.mode === "MANUAL") continue;
    snapshotFields.push({
      id: f.id,
      path: [...above(node.parentId), label(f)],
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
    groups: snapshotGroups,
  };
}
