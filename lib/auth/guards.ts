import { prisma } from "@/lib/db/client";
import { AppError } from "@/lib/errors";

/**
 * Ownership guards. Every Server Action and Route Handler that touches book data
 * calls one of these before doing anything else.
 *
 * Books are personal to one user in v1. A book that exists but belongs to someone
 * else is reported as NOT_FOUND, so IDs cannot be probed for existence.
 */

export function requireUserId(userId: string | null | undefined): string {
  if (!userId) {
    throw new AppError("UNAUTHORIZED");
  }
  return userId;
}

export async function requireBookAccess(
  userId: string | null | undefined,
  bookId: string,
): Promise<{ id: string; userId: string }> {
  const uid = requireUserId(userId);
  const book = await prisma.book.findFirst({
    where: { id: bookId, userId: uid, deletedAt: null },
    select: { id: true, userId: true },
  });
  if (!book) {
    throw new AppError("NOT_FOUND", "That book doesn't exist or you don't have access to it.");
  }
  return book;
}
