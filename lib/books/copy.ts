import { createId } from "@paralleldrive/cuid2";
import { Prisma } from "@prisma/client";

import { requireBookAccess, requireUserId } from "@/lib/auth/guards";
import { prisma } from "@/lib/db/client";
import { copyTemplateInto } from "@/lib/templates/copy";
import { MAX_TEMPLATES } from "@/lib/templates/schemas";
import { MAX_RULES } from "@/lib/validation/rules";

import { MAX_GLOSSARY_ENTRIES } from "./glossary-service";
import { MAX_COLUMNS, type CopyBookInput } from "./schemas";

/**
 * A new book from an existing one (docs/06 Phase 17): its setup, none of its work. Templates (source
 * layers), output columns, mappings, glossary and validation rules travel; documents, photos and rows
 * do not. Because the columns come along, the mappings can too, so a repeat book arrives fully
 * configured and empty.
 */

export type BookCopySummary = { templates: number; columns: number; mappings: number; glossary: number; rules: number };

export type BookCopy = BookCopySummary & { id: string; skippedMappings: number };

const liveTemplate = { deletedAt: null } satisfies Prisma.TemplateWhereInput;

/**
 * Mappings `copyTemplateInto` will copy: live column, and every input still pointing at a live field or a group.
 * A soft-deleted input field is not copied, and a deleted group leaves an input with neither id.
 */
const copyableMapping = {
  outputColumn: { deletedAt: null },
  inputs: { none: { OR: [{ field: { deletedAt: { not: null } } }, { fieldId: null, groupId: null }] } },
} satisfies Prisma.MappingWhereInput;

const ruleSelect = { outputColumnId: true, kind: true, params: true, message: true, severity: true, enabled: true } satisfies Prisma.ValidationRuleSelect;
type RuleRow = Prisma.ValidationRuleGetPayload<{ select: typeof ruleSelect }>;

/**
 * A rule moved onto the copied columns: its own column, and any column its params name (`CROSS_COLUMN`).
 * Null when either did not travel — a rule on a deleted column, or comparing against one, has nothing to check.
 */
function copiedRule(rule: RuleRow, columnMap: ReadonlyMap<string, string>): (Omit<RuleRow, "params"> & { params: Prisma.JsonValue }) | null {
  const outputColumnId = rule.outputColumnId === null ? null : columnMap.get(rule.outputColumnId);
  if (outputColumnId === undefined) return null;
  const { params } = rule;
  if (params === null || typeof params !== "object" || Array.isArray(params) || !("otherColumnId" in params)) {
    return { ...rule, outputColumnId };
  }
  const other = params.otherColumnId;
  const copy = typeof other === "string" ? columnMap.get(other) : undefined;
  return copy === undefined ? null : { ...rule, outputColumnId, params: { ...params, otherColumnId: copy } };
}

/** What a copy of the book would carry, for the counted confirmation. Counted by the same rules as `copyBook`. */
export async function bookCopySummary(userId: string, bookId: string): Promise<BookCopySummary> {
  await requireBookAccess(userId, bookId);
  const [templates, columns, mappings, glossary, rules] = await Promise.all([
    prisma.template.count({ where: { bookId, ...liveTemplate } }),
    prisma.outputColumn.findMany({ where: { bookId, deletedAt: null }, select: { id: true }, take: MAX_COLUMNS }),
    prisma.mapping.count({ where: { template: { bookId, ...liveTemplate }, ...copyableMapping } }),
    prisma.glossaryEntry.count({ where: { bookId } }),
    prisma.validationRule.findMany({ where: { bookId }, select: ruleSelect, take: MAX_RULES }),
  ]);
  const same = new Map(columns.map((c) => [c.id, c.id]));
  return {
    templates,
    columns: columns.length,
    mappings,
    glossary,
    rules: rules.filter((r) => copiedRule(r, same) !== null).length,
  };
}

export async function copyBook(userId: string, sourceBookId: string, input: CopyBookInput): Promise<BookCopy> {
  const uid = requireUserId(userId);
  await requireBookAccess(uid, sourceBookId);
  return prisma.$transaction(
    async (tx) => {
      const source = await tx.book.findUniqueOrThrow({
        where: { id: sourceBookId },
        select: { defaultModel: true, numeralSystem: true, dateEra: true, blankToken: true, illegibleToken: true },
      });
      // Numerals, era and export tokens describe the paper and the spreadsheet, and the repeat book has both.
      const book = await tx.book.create({ data: { userId: uid, name: input.name, ...source }, select: { id: true } });

      const columns = await tx.outputColumn.findMany({
        where: { bookId: sourceBookId, deletedAt: null },
        select: { id: true, key: true, label: true, dataType: true, enumValues: true, position: true, isRequired: true },
        take: MAX_COLUMNS,
      });
      const columnMap = new Map(columns.map((c) => [c.id, createId()]));
      await tx.outputColumn.createMany({
        data: columns.map(({ id, ...c }) => ({ ...c, id: columnMap.get(id) ?? createId(), bookId: book.id })),
      });

      const glossary = await tx.glossaryEntry.findMany({
        where: { bookId: sourceBookId },
        select: { term: true, meaning: true, position: true },
        take: MAX_GLOSSARY_ENTRIES,
      });
      await tx.glossaryEntry.createMany({ data: glossary.map((g) => ({ ...g, bookId: book.id })) });

      const sourceRules = await tx.validationRule.findMany({ where: { bookId: sourceBookId }, select: ruleSelect, take: MAX_RULES });
      const rules = sourceRules.flatMap((r) => {
        const copy = copiedRule(r, columnMap);
        return copy === null ? [] : [{ ...copy, params: copy.params === null ? Prisma.JsonNull : copy.params, bookId: book.id }];
      });
      await tx.validationRule.createMany({ data: rules });

      const templates = await tx.template.findMany({
        where: { bookId: sourceBookId, ...liveTemplate },
        // The order the templates list shows them in, so the copy lists them the same way.
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true, name: true },
        take: MAX_TEMPLATES,
      });
      let mappings = 0;
      let skippedMappings = 0;
      // One transaction stamps every row with the same default `createdAt`; a millisecond apart keeps the order.
      const createdFrom = Date.now();
      for (const [i, t] of templates.entries()) {
        const copy = await copyTemplateInto(tx, {
          sourceTemplateId: t.id,
          targetBookId: book.id,
          name: t.name,
          columnMap,
          createdAt: new Date(createdFrom + i),
        });
        mappings += copy.mappings;
        skippedMappings += copy.skippedMappings;
      }

      return {
        id: book.id,
        templates: templates.length,
        columns: columns.length,
        mappings,
        glossary: glossary.length,
        rules: rules.length,
        skippedMappings,
      };
    },
    { timeout: 60_000 },
  );
}
