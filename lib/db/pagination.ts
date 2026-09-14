import type { PaginationInput } from "@/lib/validation";

export type Page<T> = { items: T[]; nextCursor: string | null };

/**
 * Prisma args for an id-cursor page. Fetches one extra row to detect the next page.
 * Always pair with a deterministic `orderBy` that ends in `id`.
 *
 *   const rows = await prisma.book.findMany({ where, orderBy, ...pageArgs(input) });
 *   return toPage(rows, input.limit);
 */
export function pageArgs({ cursor, limit }: PaginationInput): {
  take: number;
  skip?: number;
  cursor?: { id: string };
} {
  return cursor ? { take: limit + 1, skip: 1, cursor: { id: cursor } } : { take: limit + 1 };
}

export function toPage<T extends { id: string }>(rows: T[], limit: number): Page<T> {
  if (rows.length <= limit) {
    return { items: rows, nextCursor: null };
  }
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return { items, nextCursor: last ? last.id : null };
}
