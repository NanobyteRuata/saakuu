import { z } from "zod";

import { modelIdSchema } from "@/lib/ai/models";
import { confirmSchema, idListSchema, idSchema, labelSchema } from "@/lib/validation";

/** Book, output column and glossary input schemas. Client-safe: shared by forms and handlers. */

export const COLUMN_TYPES = ["TEXT", "NUMBER", "INTEGER", "DATE", "BOOLEAN", "ENUM"] as const;
export type ColumnType = (typeof COLUMN_TYPES)[number];

export const COLUMN_TYPE_LABELS: Record<ColumnType, string> = {
  TEXT: "Text",
  NUMBER: "Number",
  INTEGER: "Whole number",
  DATE: "Date",
  BOOLEAN: "Yes / no",
  ENUM: "One of a list",
};

export const NUMERAL_SYSTEMS = ["AUTO", "LATIN", "MYANMAR"] as const;
export type NumeralSystem = (typeof NUMERAL_SYSTEMS)[number];

export const DATE_ERAS = ["GREGORIAN", "BUDDHIST", "MYANMAR"] as const;
export type DateEra = (typeof DATE_ERAS)[number];

export const MAX_COLUMNS = 200;

export const columnKeySchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_]{0,63}$/, {
    error: "Keys start with a lowercase letter and use only a–z, 0–9 and _ (up to 64 characters).",
  });

export const enumValuesSchema = z.array(z.string().trim().min(1, { error: "List values can't be blank." }).max(200)).max(200);

export const columnTypeSchema = z.enum(COLUMN_TYPES);

const columnFields = {
  key: columnKeySchema,
  label: labelSchema,
  dataType: columnTypeSchema,
  enumValues: enumValuesSchema,
  isRequired: z.boolean(),
};

/**
 * Rules on a column's final shape that a single field can't express. Returns a plain-language
 * problem or null. Shared by the create schema and the ops simulation.
 */
export function columnShapeProblem(col: { label: string; dataType: ColumnType; enumValues: string[] }): string | null {
  if (col.dataType === "ENUM" && col.enumValues.length === 0) {
    return `"${col.label}" is a list column, so it needs at least one value.`;
  }
  if (col.dataType !== "ENUM" && col.enumValues.length > 0) {
    return `"${col.label}" has list values but isn't a list column.`;
  }
  if (new Set(col.enumValues).size !== col.enumValues.length) {
    return `"${col.label}" has the same list value more than once.`;
  }
  return null;
}

export const columnDraftSchema = z.object(columnFields).superRefine((col, ctx) => {
  const problem = columnShapeProblem(col);
  if (problem) ctx.addIssue({ code: "custom", path: ["enumValues"], message: problem });
});

export type ColumnDraft = z.infer<typeof columnDraftSchema>;

export const createBookSchema = z
  .object({
    name: labelSchema,
    defaultModel: modelIdSchema,
    // Columns can wait: `Create columns from this template` proposes them from the first template's
    // fields, so nobody has to author a schema for data they have not read yet (docs/06 Phase 10).
    columns: z.array(columnDraftSchema).max(MAX_COLUMNS, { error: `A book can have up to ${MAX_COLUMNS} columns.` }),
  })
  .superRefine((book, ctx) => {
    const seen = new Map<string, number>();
    book.columns.forEach((col, i) => {
      if (seen.has(col.key)) {
        ctx.addIssue({ code: "custom", path: ["columns", i, "key"], message: "Another column already uses this key." });
      }
      seen.set(col.key, i);
    });
  });

export type CreateBookInput = z.infer<typeof createBookSchema>;

export const exportTokenSchema = z.string().max(20, { error: "Keep tokens to 20 characters or fewer." });

export const updateBookSchema = z
  .object({
    name: labelSchema.optional(),
    defaultModel: modelIdSchema.optional(),
    numeralSystem: z.enum(NUMERAL_SYSTEMS).optional(),
    dateEra: z.enum(DATE_ERAS).optional(),
    /** Below this self-reported confidence an untouched extracted value is underlined (docs/08 §3). */
    confidenceThreshold: z.number().min(0).max(1).optional(),
    exportPrefs: z
      .object({ blankToken: exportTokenSchema.optional(), illegibleToken: exportTokenSchema.optional() })
      .optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { error: "Nothing to update." });

export type UpdateBookInput = z.infer<typeof updateBookSchema>;

export const impactHashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/, { error: "Missing or malformed impact hash." });

export const booksImpactRequestSchema = z.object({ ids: idListSchema });

export const deleteBooksSchema = z.object({ ids: idListSchema, impactHash: impactHashSchema, confirm: confirmSchema });

export type DeleteBooksInput = z.infer<typeof deleteBooksSchema>;

// ---------- Output column ops (a diff, not a replacement) ----------

/** Client-generated id for a column added in this change; `move`/`add` may reference it. */
export const tempIdSchema = z.string().regex(/^tmp_[A-Za-z0-9_-]{1,40}$/, { error: "Malformed temporary column id." });

/** An existing column id or a `tempId` from an earlier `add` in the same change. */
const columnRefSchema = z.union([idSchema, tempIdSchema]);

export const columnOpSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("add"), tempId: tempIdSchema, afterId: columnRefSchema.nullable(), ...columnFields }),
  z.object({
    kind: z.literal("update"),
    id: idSchema,
    key: columnKeySchema.optional(),
    label: labelSchema.optional(),
    dataType: columnTypeSchema.optional(),
    enumValues: enumValuesSchema.optional(),
    isRequired: z.boolean().optional(),
  }),
  z.object({ kind: z.literal("delete"), id: idSchema }),
  z.object({ kind: z.literal("move"), id: idSchema, afterId: columnRefSchema.nullable() }),
]);

export type ColumnOp = z.infer<typeof columnOpSchema>;

export const columnOpsSchema = z.object({ ops: z.array(columnOpSchema).min(1, { error: "There are no changes to save." }).max(500) });

export const applyColumnOpsSchema = columnOpsSchema.extend({ impactHash: impactHashSchema, confirm: confirmSchema });

export type ApplyColumnOpsInput = z.infer<typeof applyColumnOpsSchema>;

// ---------- Glossary ----------

export const glossaryEntryInputSchema = z.object({
  term: z.string().trim().min(1, { error: "Enter the term as it appears on the paper." }).max(500),
  meaning: z.string().trim().min(1, { error: "Explain what the term means." }).max(2000),
});

export type GlossaryEntryInput = z.infer<typeof glossaryEntryInputSchema>;

export const glossaryEntryPatchSchema = glossaryEntryInputSchema
  .partial()
  .refine((v) => v.term !== undefined || v.meaning !== undefined, { error: "Nothing to update." });
