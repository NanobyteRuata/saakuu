import type { Prisma } from "@prisma/client";
import { generateNKeysBetween } from "fractional-indexing";

import { requireBookAccess, requireUserId } from "@/lib/auth/guards";
import { prisma } from "@/lib/db/client";
import { countingRowWhere } from "@/lib/db/scope";
import { pageArgs, toPage, type Page } from "@/lib/db/pagination";
import { AppError } from "@/lib/errors";
import { impactHash, type BooksDeleteImpact } from "@/lib/impact";
import { reviewProgress, reviewProgressForBooks } from "@/lib/review/service";
import { requestBookTransform } from "@/lib/transform/triggers";
import type { PaginationInput } from "@/lib/validation";

import type { ColumnState } from "./column-ops";
import { loadColumns } from "./columns-service";
import type { CreateBookInput, DeleteBooksInput, UpdateBookInput } from "./schemas";

type Db = Prisma.TransactionClient;

export type BookSummary = {
  id: string;
  name: string;
  updatedAt: string;
  columnCount: number;
  documentCount: number;
  rowCount: number;
  /** Review progress (docs/06 Phase 17): the books list answers "which book has work left in it?". */
  cells: number;
  reviewedCells: number;
};

export type BookSettings = {
  id: string;
  name: string;
  defaultModel: string;
  numeralSystem: "AUTO" | "LATIN" | "MYANMAR";
  dateEra: "GREGORIAN" | "BUDDHIST" | "MYANMAR";
  blankToken: string;
  illegibleToken: string;
  updatedAt: string;
};

export type BookDetail = BookSettings & {
  columns: ColumnState[];
  templateCount: number;
  /** The workspace nav's numbers (docs/05 §0), computed alongside the book rather than after it. */
  counts: BookCounts;
};

/**
 * The numbers on the workspace nav (docs/06 Phase 13). They are the spine: an operator who sees
 * `Review 412 left` does not need to be told where to go next. One aggregate serves all of them.
 */
export type BookCounts = {
  documents: number;
  rows: number;
  unreviewedCells: number;
  /** Whether an extraction is in flight, which is the only time the nav polls for these. */
  runActive: boolean;
};

/**
 * One source for the nav, the book page and the poll endpoint, so they cannot drift apart.
 * `unreviewedCells` is the review queue's own aggregate rather than a second query that could
 * disagree with the progress bar on the review screen.
 */
async function countsOf(bookId: string): Promise<BookCounts> {
  const [documents, rows, progress, running] = await Promise.all([
    prisma.document.count({ where: { bookId, deletedAt: null } }),
    prisma.row.count({ where: { bookId, ...countingRowWhere } }),
    reviewProgress(prisma, bookId),
    prisma.document.count({ where: { bookId, deletedAt: null, runState: { in: ["QUEUED", "RUNNING"] } } }),
  ]);
  return { documents, rows, unreviewedCells: progress.cells - progress.reviewedCells, runActive: running > 0 };
}

const settingsSelect = {
  id: true,
  name: true,
  defaultModel: true,
  numeralSystem: true,
  dateEra: true,
  blankToken: true,
  illegibleToken: true,
  updatedAt: true,
} satisfies Prisma.BookSelect;

type SettingsRow = Prisma.BookGetPayload<{ select: typeof settingsSelect }>;

function toSettings(book: SettingsRow): BookSettings {
  return { ...book, updatedAt: book.updatedAt.toISOString() };
}

export type BookName = { id: string; name: string };

/** Names only, for pickers: none of the counts or review aggregates `listBooks` computes per book. */
export async function listBookNames(userId: string, page: PaginationInput): Promise<Page<BookName>> {
  const uid = requireUserId(userId);
  const books = await prisma.book.findMany({
    where: { userId: uid, deletedAt: null },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    select: { id: true, name: true },
    ...pageArgs(page),
  });
  return toPage(books, page.limit);
}

export async function listBooks(userId: string, page: PaginationInput): Promise<Page<BookSummary>> {
  const uid = requireUserId(userId);
  const books = await prisma.book.findMany({
    where: { userId: uid, deletedAt: null },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    select: {
      id: true,
      name: true,
      updatedAt: true,
      _count: {
        select: {
          columns: { where: { deletedAt: null } },
          documents: { where: { deletedAt: null } },
          rows: { where: { deletedAt: null, document: { deletedAt: null, isSpecimen: false } } },
        },
      },
    },
    ...pageArgs(page),
  });
  const { items, nextCursor } = toPage(books, page.limit);
  const progress = await reviewProgressForBooks(prisma, items.map((b) => b.id));
  return {
    items: items.map((b) => ({
      id: b.id,
      name: b.name,
      updatedAt: b.updatedAt.toISOString(),
      columnCount: b._count.columns,
      documentCount: b._count.documents,
      rowCount: b._count.rows,
      cells: progress.get(b.id)?.cells ?? 0,
      reviewedCells: progress.get(b.id)?.reviewedCells ?? 0,
    })),
    nextCursor,
  };
}

export async function getBook(userId: string, bookId: string): Promise<BookDetail> {
  await requireBookAccess(userId, bookId);
  const [book, columns, templateCount, counts] = await Promise.all([
    prisma.book.findUniqueOrThrow({ where: { id: bookId }, select: settingsSelect }),
    loadColumns(prisma, bookId),
    prisma.template.count({ where: { bookId, deletedAt: null } }),
    // Every book page renders the nav, so the counts are loaded with the book rather than in a
    // second round trip after it.
    countsOf(bookId),
  ]);
  return { ...toSettings(book), columns, templateCount, counts };
}

/** The poll endpoint behind the workspace nav; the book pages get the same numbers from `getBook`. */
export async function getBookCounts(userId: string, bookId: string): Promise<BookCounts> {
  await requireBookAccess(userId, bookId);
  return countsOf(bookId);
}

export async function createBook(userId: string, input: CreateBookInput): Promise<{ id: string }> {
  const uid = requireUserId(userId);
  const columns = input.columns ?? [];
  const positions = generateNKeysBetween(null, null, columns.length);
  return prisma.book.create({
    data: {
      userId: uid,
      name: input.name,
      // Left to the schema default when the caller doesn't pick one (Phase 14).
      ...(input.defaultModel ? { defaultModel: input.defaultModel } : {}),
      columns: {
        create: columns.map((column, i) => {
          const position = positions[i];
          if (position === undefined) throw new Error("column position missing");
          return { ...column, position };
        }),
      },
    },
    select: { id: true },
  });
}

export async function updateBook(userId: string, bookId: string, input: UpdateBookInput): Promise<BookSettings> {
  await requireBookAccess(userId, bookId);
  const { exportPrefs, ...rest } = input;
  const { book, rebuild } = await prisma.$transaction(async (tx) => {
    // Locked, so two settings saves can't both read the old values and both skip the rebuild.
    const [before] = await tx.$queryRaw<{ numeralSystem: string; dateEra: string }[]>`
      SELECT "numeralSystem"::text AS "numeralSystem", "dateEra"::text AS "dateEra" FROM "Book" WHERE id = ${bookId} FOR UPDATE`;
    const updated = await tx.book.update({ where: { id: bookId }, data: { ...rest, ...exportPrefs }, select: settingsSelect });
    return { book: updated, rebuild: !before || updated.numeralSystem !== before.numeralSystem || updated.dateEra !== before.dateEra };
  });
  // Numerals and dates are converted in the transform, so every template's rows are rebuilt.
  if (rebuild) await requestBookTransform(bookId);
  return toSettings(book);
}

/** Counts for a batch book delete. Every id must be a live book the user owns. */
export async function booksDeleteImpact(userId: string, ids: string[], db: Db = prisma): Promise<BooksDeleteImpact> {
  const uid = requireUserId(userId);
  const unique = [...new Set(ids)].sort();
  const owned = await db.book.findMany({
    where: { id: { in: unique }, userId: uid, deletedAt: null },
    select: { id: true },
    take: unique.length,
  });
  if (owned.length !== unique.length) {
    throw new AppError("NOT_FOUND", "One or more of these books doesn't exist or has already been deleted.");
  }

  const liveDocuments = { bookId: { in: unique }, deletedAt: null } satisfies Prisma.DocumentWhereInput;
  const [documents, photos, rows, editedCells] = await Promise.all([
    db.document.count({ where: liveDocuments }),
    db.photo.count({ where: { deletedAt: null, document: liveDocuments } }),
    db.row.count({ where: { deletedAt: null, document: liveDocuments } }),
    db.cell.count({ where: { isEdited: true, row: { deletedAt: null, document: liveDocuments } } }),
  ]);
  const counts = { books: unique.length, documents, photos, rows, editedCells };
  return { impactHash: impactHash({ action: "books.delete", ids: unique, ...counts }), ...counts };
}

export async function deleteBooks(userId: string, input: DeleteBooksInput): Promise<{ deleted: number }> {
  const uid = requireUserId(userId);
  return prisma.$transaction(async (tx) => {
    const impact = await booksDeleteImpact(uid, input.ids, tx);
    if (impact.impactHash !== input.impactHash) {
      throw new AppError("CONFLICT", "These books changed since you reviewed the deletion. Review it again.");
    }
    const { count } = await tx.book.updateMany({
      where: { id: { in: input.ids }, userId: uid, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    return { deleted: count };
  });
}
