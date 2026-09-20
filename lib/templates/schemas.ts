import { z } from "zod";

import { modelIdSchema } from "@/lib/ai/models";
import { impactHashSchema } from "@/lib/books/schemas";
import { confirmSchema, idListSchema, idSchema, labelSchema } from "@/lib/validation";

/** Template source-layer input schemas. Client-safe: shared by forms and handlers. */

/** How many templates one book can hold. Client-safe so a picker can ask for all of them at once. */
export const MAX_TEMPLATES = 200;

export const TEMPLATE_KINDS = ["FORM", "TABLE"] as const;
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];

export const FIELD_TYPES = ["TEXT", "NUMBER", "INTEGER", "DATE", "MARK", "CHOICE", "AGE", "FRACTION"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const FIELD_MODES = ["EXTRACT", "SKIP", "MANUAL"] as const;
export type FieldMode = (typeof FIELD_MODES)[number];

export const CONFIG_STATES = ["DRAFT", "READY", "CONFLICTED"] as const;
export type ConfigState = (typeof CONFIG_STATES)[number];

export const MAX_FIELDS = 500;
export const MAX_GROUPS = 100;
export const MAX_ANCHORS = 50;
export const MAX_CHOICES = 200;
export const MAX_MARK_SYMBOLS = 20;

const templateNameSchema = labelSchema;

/** Optional free text: trimmed, and blank becomes null so "cleared" is stored as absent. */
function optionalText(max: number) {
  return z
    .string()
    .trim()
    .max(max, { error: `Keep this to ${max} characters or fewer.` })
    .transform((v) => (v === "" ? null : v))
    .nullable();
}

/** e.g. "my" or "my,en". Blank clears the hint. */
export const languageHintSchema = z
  .string()
  .trim()
  .regex(/^$|^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*(,[a-z]{2,3}(-[A-Za-z0-9]{2,8})*)*$/, {
    error: "Use language codes such as my or my,en.",
  })
  .transform((v) => (v === "" ? null : v))
  .nullable();

export const anchorsSchema = z
  .array(z.string().trim().min(1, { error: "Anchors can't be blank." }).max(200))
  .max(MAX_ANCHORS, { error: `A template can have up to ${MAX_ANCHORS} anchors.` })
  .refine((a) => new Set(a).size === a.length, { error: "Each anchor can only be listed once." });

export const createTemplateSchema = z.object({
  name: templateNameSchema,
  kind: z.enum(TEMPLATE_KINDS, { error: "Choose Form or Table." }),
  modelOverride: modelIdSchema.nullable().optional(),
});

export type CreateTemplateInput = z.infer<typeof createTemplateSchema>;

export const updateTemplateSchema = z
  .object({
    name: templateNameSchema.optional(),
    instructions: optionalText(5000).optional(),
    anchors: anchorsSchema.optional(),
    languageHint: languageHintSchema.optional(),
    modelOverride: modelIdSchema.nullable().optional(),
    doubleExtraction: z.literal(false, { error: "Double extraction isn't available yet." }).optional(),
    sequenceFieldId: idSchema.nullable().optional(),
    kind: z.never({ error: "A template's type can't change. Duplicate it as a new template instead." }).optional(),
  })
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined), { error: "Nothing to update." });

export type UpdateTemplateInput = z.infer<typeof updateTemplateSchema>;

export const duplicateTemplateSchema = z.object({
  name: templateNameSchema.optional(),
  kind: z.enum(TEMPLATE_KINDS).optional(),
  includeMappings: z.boolean(),
});

export type DuplicateTemplateInput = z.infer<typeof duplicateTemplateSchema>;

export const templatesImpactRequestSchema = z.object({ ids: idListSchema });

export const deleteTemplatesSchema = z.object({ ids: idListSchema, impactHash: impactHashSchema, confirm: confirmSchema });

export type DeleteTemplatesInput = z.infer<typeof deleteTemplatesSchema>;

// ---------- Groups ----------

export const GROUP_SELECTIONS = ["NONE", "ONE_OF", "ANY_OF"] as const;
export type GroupSelection = (typeof GROUP_SELECTIONS)[number];

export const NONE_MARKED = ["BLANK", "REVIEW", "ERROR"] as const;
export type NoneMarked = (typeof NONE_MARKED)[number];

export const MULTIPLE_MARKED = ["REVIEW", "ERROR"] as const;
export type MultipleMarked = (typeof MULTIPLE_MARKED)[number];

/** A sibling of either kind: groups and fields share one order under a parent. */
export const siblingRefSchema = z.object({ kind: z.enum(["field", "group"]), id: idSchema });

const groupProps = {
  labelSource: z.string().trim().min(1, { error: "Enter the header as it is written on the paper." }).max(500),
  labelMeaning: optionalText(500),
  selection: z.enum(GROUP_SELECTIONS),
  noneMarked: z.enum(NONE_MARKED),
  multipleMarked: z.enum(MULTIPLE_MARKED),
  note: optionalText(2000),
};

export const createGroupSchema = z.object({
  labelSource: groupProps.labelSource,
  labelMeaning: groupProps.labelMeaning.optional(),
  /** Parent group; null or absent = top level. The group is appended at the end of that parent. */
  parentGroupId: idSchema.nullable().optional(),
  // No selection here: a new group has no options yet. Set it with PATCH once it holds 2 mark fields.
  noneMarked: groupProps.noneMarked.optional(),
  multipleMarked: groupProps.multipleMarked.optional(),
  note: groupProps.note.optional(),
});

export type CreateGroupInput = z.infer<typeof createGroupSchema>;

export const updateGroupSchema = z
  .object({
    labelSource: groupProps.labelSource.optional(),
    labelMeaning: groupProps.labelMeaning.optional(),
    selection: groupProps.selection.optional(),
    noneMarked: groupProps.noneMarked.optional(),
    multipleMarked: groupProps.multipleMarked.optional(),
    note: groupProps.note.optional(),
    /** Move: new parent (null = top level) and the sibling of either kind to place after (null = first). */
    move: z.object({ parentGroupId: idSchema.nullable(), after: siblingRefSchema.nullable() }).optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { error: "Nothing to update." });

export type UpdateGroupInput = z.infer<typeof updateGroupSchema>;

export const deleteGroupSchema = z.object({ impactHash: impactHashSchema, confirm: confirmSchema });

export type DeleteGroupInput = z.infer<typeof deleteGroupSchema>;

// ---------- Fields ----------

export const markSymbolsSchema = z
  .record(z.string().trim().min(1).max(20), z.union([z.boolean(), z.literal("count")]))
  .refine((m) => Object.keys(m).length <= MAX_MARK_SYMBOLS, { error: `Up to ${MAX_MARK_SYMBOLS} symbols.` });

export type MarkSymbols = z.infer<typeof markSymbolsSchema>;

/**
 * What a two-digit year means for one date field (Phase 6). `REFUSE` (the default) flags it rather than
 * guessing a century. `CENTURY` reads it in the book's own century; `PIVOT` splits at a year, so years at
 * or above the pivot belong to the century before.
 */
export const TWO_DIGIT_YEAR_RULES = ["REFUSE", "CENTURY", "PIVOT"] as const;
export type TwoDigitYearRule = (typeof TWO_DIGIT_YEAR_RULES)[number];

export const dateFieldOptionsSchema = z
  .object({
    twoDigitYear: z.enum(TWO_DIGIT_YEAR_RULES).default("REFUSE"),
    pivotYear: z.number().int().min(0).max(99).nullable().default(null),
  })
  .refine((o) => o.twoDigitYear !== "PIVOT" || o.pivotYear !== null, { error: "Choose the year two-digit dates split at.", path: ["pivotYear"] });

export type DateFieldOptions = z.infer<typeof dateFieldOptionsSchema>;

/** Settings that belong to a field's type. Cleared when the type changes, like choices and mark symbols. */
export const fieldTypeOptionsSchema = z.object({ date: dateFieldOptionsSchema.optional() });

export type FieldTypeOptions = z.infer<typeof fieldTypeOptionsSchema>;

export const choicesSchema = z
  .array(z.string().trim().min(1, { error: "Choices can't be blank." }).max(200))
  .max(MAX_CHOICES, { error: `Up to ${MAX_CHOICES} choices.` });

const fieldProps = {
  labelSource: z.string().trim().min(1, { error: "Enter the label as it is written on the paper." }).max(500),
  labelMeaning: optionalText(500),
  dataType: z.enum(FIELD_TYPES),
  mode: z.enum(FIELD_MODES),
  note: optionalText(2000),
  choices: choicesSchema,
  markSymbols: markSymbolsSchema.nullable(),
  typeOptions: fieldTypeOptionsSchema.nullable(),
};

/** Rules on a field's final shape. Returns a plain-language problem or null. */
export function fieldShapeProblem(f: {
  dataType: FieldType;
  choices: string[];
  markSymbols: MarkSymbols | null;
  typeOptions?: FieldTypeOptions | null;
}): string | null {
  if (f.typeOptions?.date) {
    if (f.dataType !== "DATE") return "Only date fields can have date options.";
    if (f.typeOptions.date.twoDigitYear === "PIVOT" && f.typeOptions.date.pivotYear === null) {
      return "Choose the year two-digit dates split at.";
    }
  }
  if (f.dataType === "CHOICE" && f.choices.length === 0) return "A choice field needs at least one choice.";
  if (f.dataType !== "CHOICE" && f.choices.length > 0) return "Only choice fields can have choices.";
  if (new Set(f.choices).size !== f.choices.length) return "Each choice can only be listed once.";
  if (f.dataType !== "MARK" && f.markSymbols !== null && Object.keys(f.markSymbols).length > 0) {
    return "Only mark fields can have symbol meanings.";
  }
  return null;
}

/** Shape rules (e.g. a choice field needs choices) are checked by the service, which returns a plain message. */
export const createFieldSchema = z.object({
  labelSource: fieldProps.labelSource,
  labelMeaning: fieldProps.labelMeaning.optional(),
  /** Absent: Mark / tick inside a selection group, Text elsewhere. */
  dataType: fieldProps.dataType.optional(),
  mode: fieldProps.mode.default("EXTRACT"),
  note: fieldProps.note.optional(),
  /** Parent group at any depth; null or absent = top level. Appended at the end of that parent. */
  groupId: idSchema.nullable().optional(),
  choices: fieldProps.choices.default([]),
  markSymbols: fieldProps.markSymbols.optional(),
  typeOptions: fieldProps.typeOptions.optional(),
});

export type CreateFieldInput = z.infer<typeof createFieldSchema>;

export const updateFieldSchema = z
  .object({
    labelSource: fieldProps.labelSource.optional(),
    labelMeaning: fieldProps.labelMeaning.optional(),
    dataType: fieldProps.dataType.optional(),
    mode: fieldProps.mode.optional(),
    note: fieldProps.note.optional(),
    choices: fieldProps.choices.optional(),
    markSymbols: fieldProps.markSymbols.optional(),
    typeOptions: fieldProps.typeOptions.optional(),
    /** Move: new parent group (null = top level) and the sibling of either kind to place after (null = first). */
    move: z.object({ groupId: idSchema.nullable(), after: siblingRefSchema.nullable() }).optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { error: "Nothing to update." });

export type UpdateFieldInput = z.infer<typeof updateFieldSchema>;

export const fieldsImpactRequestSchema = z.object({ ids: idListSchema });

export const deleteFieldsSchema = z.object({ ids: idListSchema, impactHash: impactHashSchema, confirm: confirmSchema });

export type DeleteFieldsInput = z.infer<typeof deleteFieldsSchema>;
