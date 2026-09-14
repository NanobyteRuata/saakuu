import { MAX_FIELDS, MAX_GROUPS } from "./schemas";
import type { Db } from "./access";
import { buildTree, type Sibling, type Tree } from "./tree";
import { fieldSelect, groupSelect, toFieldView, type FieldView, type GroupView } from "./views";

export type SourceTree = Tree<GroupView, FieldView>;

/** Every group and live field of a template, and the tree built from them. Bounded by MAX_GROUPS and MAX_FIELDS. */
export async function loadSourceTree(
  db: Db,
  templateId: string,
): Promise<{ groups: GroupView[]; fields: FieldView[]; tree: SourceTree }> {
  const groups = await db.fieldGroup.findMany({ where: { templateId }, select: groupSelect, take: MAX_GROUPS });
  const rows = await db.field.findMany({ where: { templateId, deletedAt: null }, select: fieldSelect, take: MAX_FIELDS });
  const fields = rows.map(toFieldView);
  return { groups, fields, tree: buildTree(groups, fields) };
}

/** Writes re-spaced sibling keys (only needed after a key collision). */
export async function applySiblingRewrites(tx: Db, rewrites: Sibling[]): Promise<void> {
  for (const { kind, id, position } of rewrites) {
    if (kind === "field") await tx.field.update({ where: { id }, data: { position } });
    else await tx.fieldGroup.update({ where: { id }, data: { position } });
  }
}
