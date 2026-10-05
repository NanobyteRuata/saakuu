import { Prisma } from "@prisma/client";

/**
 * What counts as the book's output (Phase 15, decisions 71 and 78).
 *
 * A specimen is a real Document — same upload, same processing, same extraction, same raw layer —
 * uploaded to build a template against. It is left out of the numbers that mean *work to do*: the
 * output table, the export, review progress, the template's document count and `Extract all`. Since
 * decision 78 it belongs to its template and is out of Documents too (the list, upload days, the run
 * drawer, the nav count; those filter on `isSpecimen` directly). It reaches the documents only as a
 * copy, never by clearing the flag.
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
