import { Prisma } from "@prisma/client";
import { generateKeyBetween } from "fractional-indexing";

import { requireBookAccess } from "@/lib/auth/guards";
import { prisma } from "@/lib/db/client";
import { toPage, type Page } from "@/lib/db/pagination";
import { AppError } from "@/lib/errors";
import type { PaginationInput } from "@/lib/validation";

import type { GlossaryEntryInput } from "./schemas";

export type GlossaryEntryView = { id: string; term: string; meaning: string };

export const MAX_GLOSSARY_ENTRIES = 500;

type EntryRow = GlossaryEntryView & { position: string };

const NOT_FOUND_MESSAGE = "That glossary entry doesn't exist or was already deleted.";

/**
 * Glossary in manual order. Raw SQL because fractional-index keys must compare byte-wise
 * (`COLLATE "C"`); the database's default collation may sort "aZ" after "aa".
 */
export async function listGlossary(userId: string, bookId: string, page: PaginationInput): Promise<Page<GlossaryEntryView>> {
  await requireBookAccess(userId, bookId);
  let after: { id: string; position: string } | null = null;
  if (page.cursor) {
    after = await prisma.glossaryEntry.findFirst({ where: { id: page.cursor, bookId }, select: { id: true, position: true } });
    if (!after) throw new AppError("VALIDATION", "The glossary changed while loading. Reload and try again.");
  }
  const rows = await prisma.$queryRaw<EntryRow[]>`
    SELECT id, term, meaning, position FROM "GlossaryEntry"
    WHERE "bookId" = ${bookId}
    ${after ? Prisma.sql`AND (position COLLATE "C", id COLLATE "C") > (${after.position} COLLATE "C", ${after.id} COLLATE "C")` : Prisma.empty}
    ORDER BY position COLLATE "C", id COLLATE "C"
    LIMIT ${page.limit + 1}`;
  const { items, nextCursor } = toPage(rows, page.limit);
  return { items: items.map(({ id, term, meaning }) => ({ id, term, meaning })), nextCursor };
}

export async function createGlossaryEntry(userId: string, bookId: string, input: GlossaryEntryInput): Promise<GlossaryEntryView> {
  await requireBookAccess(userId, bookId);
  const count = await prisma.glossaryEntry.count({ where: { bookId } });
  if (count >= MAX_GLOSSARY_ENTRIES) {
    throw new AppError("VALIDATION", `A glossary can hold up to ${MAX_GLOSSARY_ENTRIES} entries.`);
  }
  const [last] = await prisma.$queryRaw<{ position: string }[]>`
    SELECT position FROM "GlossaryEntry" WHERE "bookId" = ${bookId} ORDER BY position COLLATE "C" DESC LIMIT 1`;
  return prisma.glossaryEntry.create({
    data: { bookId, term: input.term, meaning: input.meaning, position: generateKeyBetween(last?.position ?? null, null) },
    select: { id: true, term: true, meaning: true },
  });
}

export async function updateGlossaryEntry(
  userId: string,
  bookId: string,
  entryId: string,
  input: Partial<GlossaryEntryInput>,
): Promise<GlossaryEntryView> {
  await requireBookAccess(userId, bookId);
  const { count } = await prisma.glossaryEntry.updateMany({ where: { id: entryId, bookId }, data: input });
  if (count === 0) throw new AppError("NOT_FOUND", NOT_FOUND_MESSAGE);
  return prisma.glossaryEntry.findUniqueOrThrow({ where: { id: entryId }, select: { id: true, term: true, meaning: true } });
}

export async function deleteGlossaryEntry(userId: string, bookId: string, entryId: string): Promise<{ deleted: true }> {
  await requireBookAccess(userId, bookId);
  const { count } = await prisma.glossaryEntry.deleteMany({ where: { id: entryId, bookId } });
  if (count === 0) throw new AppError("NOT_FOUND", NOT_FOUND_MESSAGE);
  return { deleted: true };
}
