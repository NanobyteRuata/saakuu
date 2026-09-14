import { notFound, redirect } from "next/navigation";
import { cache } from "react";

import { getSessionUser } from "@/lib/auth/session";
import { getBook } from "@/lib/books/service";
import { AppError } from "@/lib/errors";
import { idSchema } from "@/lib/validation";

/**
 * The signed-in user and their book, once per request (shared by the layout and every tab).
 * Missing, malformed and someone else's book ids all render the not-found page.
 */
export const loadBookPage = cache(async (bookId: string) => {
  const user = await getSessionUser();
  if (!user) redirect("/sign-in");
  if (!idSchema.safeParse(bookId).success) notFound();
  try {
    return { user, book: await getBook(user.id, bookId) };
  } catch (err) {
    if (err instanceof AppError && err.code === "NOT_FOUND") notFound();
    throw err;
  }
});
