import type { TemplateSnapshot } from "./provider";

/**
 * Short names for a template's fields in a model answer (prompt v2, Phase 23): `f1`, `f2`, … in paper
 * order. A field id is 24 letters and was written out once per cell; on a register page that was a
 * real share of what the answer cost. Every field is numbered, Skip ones too, so in a table the
 * number is the column's position from the left.
 *
 * The one place the numbering is defined. The prompt lists fields by these names, the response schema
 * allows only these names, and validation turns them back into ids before anything is stored — no
 * alias ever reaches the database.
 */
export type FieldAliases = { aliasOf: Map<string, string>; idOf: Map<string, string> };

export function fieldAliases(template: TemplateSnapshot): FieldAliases {
  const aliasOf = new Map<string, string>();
  const idOf = new Map<string, string>();
  template.fields.forEach((f, i) => {
    const alias = `f${i + 1}`;
    aliasOf.set(f.id, alias);
    idOf.set(alias, f.id);
  });
  return { aliasOf, idOf };
}
