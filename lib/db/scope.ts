import { Prisma } from "@prisma/client";

/**
 * What counts as the book's output (Phase 15, decision 71).
 *
 * A specimen is a real Document — same upload, same processing, same extraction, same raw layer —
 * uploaded to build a template against. Its rows are built like any other document's, so promoting
 * it is a flag flip rather than a re-extraction. What makes it a specimen is only that it is left
 * out of the numbers that mean *work to do*: the output table, the export, review progress, the
 * template's document count and `Extract all`. It stays in the Documents list, which is where the
 * number means *files I have* and where the promote action lives.
 *
 * These predicates exist because that rule was spelled out independently in five raw queries and
 * two Prisma ones. One specimen rule, one place to change it.
 *
 * The SQL fragments assume the query's usual aliases: `d` for Document, `t` for Template.
 */
export const COUNTING_DOC_SQL = Prisma.sql`d."deletedAt" IS NULL AND NOT d."isSpecimen"`;

/** As above, for the queries that also join Template. */
export const COUNTING_DOC_TEMPLATE_SQL = Prisma.sql`d."deletedAt" IS NULL AND NOT d."isSpecimen" AND t."deletedAt" IS NULL`;

/** The Prisma twin of `COUNTING_DOC_SQL`, for `document.count` / `findMany`. */
export const countingDocumentWhere = { deletedAt: null, isSpecimen: false } satisfies Prisma.DocumentWhereInput;

/** The Prisma twin of `COUNTING_DOC_TEMPLATE_SQL`, reached through a row. */
export const countingRowWhere = {
  deletedAt: null,
  document: { deletedAt: null, isSpecimen: false, template: { deletedAt: null } },
} satisfies Prisma.RowWhereInput;
