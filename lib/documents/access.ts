import type { Prisma } from "@prisma/client";

import { requireUserId } from "@/lib/auth/guards";
import { prisma } from "@/lib/db/client";
import { AppError } from "@/lib/errors";

export type Db = Prisma.TransactionClient;

const DOCUMENT_NOT_FOUND = "That document doesn't exist or was deleted.";
const PHOTO_NOT_FOUND = "That photo doesn't exist or was deleted.";

function liveOwnedDocument(userId: string) {
  return {
    deletedAt: null,
    template: { deletedAt: null },
    book: { userId, deletedAt: null },
  } satisfies Prisma.DocumentWhereInput;
}

/** A live document on a live template in a live book the user owns. */
export async function requireDocumentAccess(
  userId: string | null | undefined,
  documentId: string,
  db: Db = prisma,
): Promise<{ id: string; bookId: string; templateId: string }> {
  const uid = requireUserId(userId);
  const doc = await db.document.findFirst({
    where: { id: documentId, ...liveOwnedDocument(uid) },
    select: { id: true, bookId: true, templateId: true },
  });
  if (!doc) throw new AppError("NOT_FOUND", DOCUMENT_NOT_FOUND);
  return doc;
}

/** Every id must be a live document the user owns, all in one book; otherwise NOT_FOUND. */
export async function requireDocumentsAccess(
  userId: string | null | undefined,
  ids: string[],
  db: Db = prisma,
): Promise<{ bookId: string; documents: { id: string; templateId: string }[] }> {
  const uid = requireUserId(userId);
  const unique = [...new Set(ids)];
  const docs = await db.document.findMany({
    where: { id: { in: unique }, ...liveOwnedDocument(uid) },
    select: { id: true, bookId: true, templateId: true },
    take: unique.length,
  });
  const bookIds = new Set(docs.map((d) => d.bookId));
  const bookId = docs[0]?.bookId;
  if (docs.length !== unique.length || !bookId) {
    throw new AppError("NOT_FOUND", "One or more of these documents doesn't exist or has already been deleted.");
  }
  if (bookIds.size > 1) {
    throw new AppError("VALIDATION", "These documents are in different books. Choose documents from one book.");
  }
  return { bookId, documents: docs.map((d) => ({ id: d.id, templateId: d.templateId })) };
}

export async function requirePhotoAccess(
  userId: string | null | undefined,
  photoId: string,
  db: Db = prisma,
): Promise<{ id: string; documentId: string; bookId: string }> {
  const uid = requireUserId(userId);
  const photo = await db.photo.findFirst({
    where: { id: photoId, document: liveOwnedDocument(uid) },
    select: { id: true, documentId: true, document: { select: { bookId: true } } },
  });
  if (!photo) throw new AppError("NOT_FOUND", PHOTO_NOT_FOUND);
  return { id: photo.id, documentId: photo.documentId, bookId: photo.document.bookId };
}

/**
 * Locks the book row for the rest of the transaction. Document structure changes (new documents,
 * grouping, splitting, page order, moves, deletes) take this lock so positions and counts can't race.
 */
export async function lockBook(tx: Db, bookId: string): Promise<void> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Book" WHERE id = ${bookId} AND "deletedAt" IS NULL FOR UPDATE`;
  if (rows.length === 0) throw new AppError("NOT_FOUND", "That book doesn't exist or was deleted.");
}

/** Refuses restructuring documents whose extraction output would silently stop matching their pages. */
export async function assertNoExtractionOutput(tx: Db, documentIds: string[], action: string): Promise<void> {
  const [runs, rows] = await Promise.all([
    tx.extractionRun.count({ where: { documentId: { in: documentIds } } }),
    tx.row.count({ where: { documentId: { in: documentIds } } }),
  ]);
  if (runs > 0 || rows > 0) {
    throw new AppError(
      "CONFLICT",
      `You can't ${action} a document that has already been extracted, because its rows would no longer match its pages. Move it to its template again to clear the extraction first.`,
    );
  }
}
