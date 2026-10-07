import { MAX_FIELDS } from "./schemas";
import type { Db } from "./access";
import { orderFields, type FieldList } from "./field-list";
import type { Positioned } from "./positions";
import { fieldSelect, toFieldView, type FieldView } from "./views";

export type SourceFields = FieldList<FieldView>;

/** Every live field of a template, in paper order. Bounded by MAX_FIELDS. */
export async function loadSourceFields(db: Db, templateId: string): Promise<SourceFields> {
  const rows = await db.field.findMany({ where: { templateId, deletedAt: null }, select: fieldSelect, take: MAX_FIELDS });
  return orderFields(rows.map(toFieldView));
}

/** Writes re-spaced field keys (only needed after a key collision). */
export async function applyPositionRewrites(tx: Db, rewrites: Positioned[]): Promise<void> {
  for (const { id, position } of rewrites) await tx.field.update({ where: { id }, data: { position } });
}
