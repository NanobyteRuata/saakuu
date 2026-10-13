import { Prisma } from "@prisma/client";

/**
 * The document changed after it was last read successfully, so its rows no longer match its pages
 * (decision 58). A page transformed, replaced or added all invalidate the previous reading in the
 * same way; a marker that caught only transforms would still miss a third of the cases while being
 * trusted for all of them.
 *
 * Both sides are denormalised onto Document because the Documents list is virtualised and
 * cursor-paginated: "max over this document's photos, against its latest run" would be a join per row.
 */
export function isStale(d: { contentChangedAt: Date | null; lastExtractedAt: Date | null }): boolean {
  return d.contentChangedAt !== null && d.lastExtractedAt !== null && d.contentChangedAt > d.lastExtractedAt;
}

/**
 * The document was read under another fingerprint than its template has now (decision 88): the AI was
 * told something different about the fields when it read this. A template with no fingerprint yet has
 * not changed since Phase 28 shipped, so nothing of it is flagged (decision 89). It only flags;
 * nothing is read again by itself.
 */
export function fieldsChanged(d: { readWithKey: string | null }, template: { readingKey: string | null }): boolean {
  return d.readWithKey !== null && template.readingKey !== null && d.readWithKey !== template.readingKey;
}

/** The same test in SQL. Keep in step with `fieldsChanged`; `d` is the Document alias and `t` its Template. */
export const FIELDS_CHANGED_SQL = Prisma.sql`(d."readWithKey" IS NOT NULL AND t."readingKey" IS NOT NULL AND d."readWithKey" <> t."readingKey")`;

/** The same test in SQL, for the list filter. Keep in step with `isStale`; `d` is the Document alias. */
export const STALE_SQL = Prisma.sql`(d."contentChangedAt" IS NOT NULL AND d."lastExtractedAt" IS NOT NULL AND d."contentChangedAt" > d."lastExtractedAt")`;
