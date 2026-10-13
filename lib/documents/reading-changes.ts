import { prisma } from "@/lib/db/client";
import { AppError } from "@/lib/errors";
import { impactHash } from "@/lib/impact";
import { lockTemplate, requireTemplateAccess, type Db } from "@/lib/templates/access";

import { requireDocumentAccess } from "./access";
import type { KeepReadingsInput } from "./schemas";
import { FIELDS_CHANGED_SQL } from "./staleness";

/**
 * Documents read before a template's latest field changes (decision 88), and the operator's free way
 * out of reading them again: Keep sets a document's fingerprint to its template's, which says "this
 * reading is still good" (a typo fixed in a name, a note reworded). Nothing is read, no run is made
 * or rewritten, and no cell changes. Specimens are left out: a test page keeps its own note in the
 * test pane until it is tested again.
 */

export type ReadingChanges = {
  impactHash: string;
  /** Documents of this template that have a reading. */
  read: number;
  /** Of those, the ones read before the latest field changes. */
  changed: number;
};

async function countChanges(db: Db, templateId: string): Promise<ReadingChanges> {
  const [row] = await db.$queryRaw<{ read: number; changed: number; readingKey: string | null }[]>`
    SELECT count(d.id) FILTER (WHERE d."readWithKey" IS NOT NULL)::int AS read,
           count(d.id) FILTER (WHERE ${FIELDS_CHANGED_SQL})::int AS changed,
           t."readingKey" AS "readingKey"
    FROM "Template" t
    LEFT JOIN "Document" d ON d."templateId" = t.id AND d."deletedAt" IS NULL AND NOT d."isSpecimen"
    WHERE t.id = ${templateId}
    GROUP BY t.id`;
  const read = row?.read ?? 0;
  const changed = row?.changed ?? 0;
  return {
    impactHash: impactHash({ action: "template.keep-readings", templateId, readingKey: row?.readingKey ?? null, read, changed }),
    read,
    changed,
  };
}

export async function readingChanges(userId: string, templateId: string): Promise<ReadingChanges> {
  await requireTemplateAccess(userId, templateId);
  return countChanges(prisma, templateId);
}

/** Keeps every flagged reading of a template. Refused if the count or the fields moved since it was shown. */
export async function keepReadings(userId: string, templateId: string, input: KeepReadingsInput): Promise<{ kept: number }> {
  await requireTemplateAccess(userId, templateId);
  return prisma.$transaction(async (tx) => {
    await lockTemplate(tx, templateId);
    const now = await countChanges(tx, templateId);
    if (now.impactHash !== input.impactHash) {
      throw new AppError("CONFLICT", "These documents or your fields changed since you reviewed this. Review it again.");
    }
    const kept = await tx.$executeRaw`
      UPDATE "Document" d SET "readWithKey" = t."readingKey"
      FROM "Template" t
      WHERE t.id = d."templateId" AND d."templateId" = ${templateId} AND d."deletedAt" IS NULL AND NOT d."isSpecimen"
        AND ${FIELDS_CHANGED_SQL}`;
    return { kept };
  });
}

/** Keeps one document's reading. Nothing to do when it isn't flagged. */
export async function keepReading(userId: string, documentId: string): Promise<{ kept: boolean }> {
  const { templateId } = await requireDocumentAccess(userId, documentId);
  return prisma.$transaction(async (tx) => {
    await lockTemplate(tx, templateId);
    const kept = await tx.$executeRaw`
      UPDATE "Document" d SET "readWithKey" = t."readingKey"
      FROM "Template" t
      WHERE t.id = d."templateId" AND d.id = ${documentId} AND d."templateId" = ${templateId} AND ${FIELDS_CHANGED_SQL}`;
    return { kept: kept > 0 };
  });
}
