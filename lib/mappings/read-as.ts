import { z } from "zod";

import { AGE_UNITS, markSymbolsSchema, NEW_AGE_UNIT, TWO_DIGIT_YEAR_RULES, type FieldType, type MarkSymbols } from "@/lib/templates/schemas";

/**
 * Read as (Phase 26, decision 86): how one field a mapping reads is converted before the mapping
 * uses it. It lives on the mapping's source, never on the field, so changing it costs no reading.
 * Every source carries its own explicit value: nothing here follows the field, so a later change of
 * a field's type cannot change a cell. Client-safe: the editor, the API and the transform share it.
 */

export const READ_AS_KINDS = ["TEXT", "NUMBER", "DATE", "AGE", "FRACTION", "MARK", "CHOICE"] as const;
export type ReadAsKind = (typeof READ_AS_KINDS)[number];

export const readAsSchema = z.discriminatedUnion("kind", [
  /** As written. */
  z.object({ kind: z.literal("TEXT") }),
  z.object({ kind: z.literal("NUMBER") }),
  /** What a two-digit year means (decision 36). `PIVOT` needs its year; `readAsProblem` says so. */
  z.object({
    kind: z.literal("DATE"),
    twoDigitYear: z.enum(TWO_DIGIT_YEAR_RULES),
    pivotYear: z.number().int().min(0).max(99).nullable(),
  }),
  z.object({ kind: z.literal("AGE"), unit: z.enum(AGE_UNITS) }),
  z.object({ kind: z.literal("FRACTION") }),
  /** What each symbol means. With none, anything written counts as ticked. */
  z.object({ kind: z.literal("MARK"), symbols: markSymbolsSchema }),
  /** Matched against the field's own choices, which are sent to the AI and so stay on the field. */
  z.object({ kind: z.literal("CHOICE") }),
]);

export type ReadAs = z.infer<typeof readAsSchema>;

export const AS_WRITTEN: ReadAs = { kind: "TEXT" };

/** Why a Read as can't be saved, in plain language; null when it can. */
export function readAsProblem(readAs: ReadAs): string | null {
  if (readAs.kind === "DATE" && readAs.twoDigitYear === "PIVOT" && readAs.pivotYear === null) {
    return "Choose the year two-digit dates split at.";
  }
  return null;
}

/** A stored Read as. The column is required and only ever written through `readAsSchema`. */
export function parseReadAs(value: unknown): ReadAs {
  const parsed = readAsSchema.safeParse(value);
  return parsed.success ? parsed.data : AS_WRITTEN;
}

/** Symbols taken to mean "no" until the operator says otherwise. Every other symbol means ticked. */
const NO_SYMBOLS = new Set(["✗", "✘", "×"]);

/** What a listed symbol is taken to mean when it is first given a meaning: ticked, unless it is a cross. */
export function defaultSymbolMeaning(symbol: string): boolean {
  return !NO_SYMBOLS.has(symbol.trim());
}

/**
 * What a source reads as when nothing says otherwise: decided by the field's type, once, when the
 * source is first added. A mark's listed symbols are given a yes or no; counting is never assumed.
 */
export function defaultReadAs(field: { dataType: FieldType; markSymbols: MarkSymbols | null }): ReadAs {
  switch (field.dataType) {
    case "TEXT":
      return AS_WRITTEN;
    case "NUMBER":
    case "INTEGER":
      return { kind: "NUMBER" };
    case "DATE":
      return { kind: "DATE", twoDigitYear: "REFUSE", pivotYear: null };
    case "AGE":
      return { kind: "AGE", unit: NEW_AGE_UNIT };
    case "FRACTION":
      return { kind: "FRACTION" };
    case "CHOICE":
      return { kind: "CHOICE" };
    case "MARK":
      return { kind: "MARK", symbols: Object.fromEntries(Object.keys(field.markSymbols ?? {}).map((s) => [s, defaultSymbolMeaning(s)])) };
  }
}

/** The same kind with that kind's starting options, for when the operator picks another kind. */
export function readAsOfKind(kind: ReadAsKind, field: { markSymbols: MarkSymbols | null }): ReadAs {
  switch (kind) {
    case "TEXT":
      return AS_WRITTEN;
    case "NUMBER":
      return { kind };
    case "DATE":
      return defaultReadAs({ dataType: "DATE", markSymbols: null });
    case "AGE":
      return defaultReadAs({ dataType: "AGE", markSymbols: null });
    case "FRACTION":
      return { kind };
    case "CHOICE":
      return { kind };
    case "MARK":
      return defaultReadAs({ dataType: "MARK", markSymbols: field.markSymbols });
  }
}
