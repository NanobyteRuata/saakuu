import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { BookList } from "@/components/books/book-list";
import { getSessionUser } from "@/lib/auth/session";
import { listBooks } from "@/lib/books/service";
import { PAGE_LIMIT_DEFAULT } from "@/lib/validation";

export const metadata: Metadata = { title: "Books · SaaKuu" };

export default async function BooksPage() {
  const user = await getSessionUser();
  if (!user) redirect("/sign-in");
  const page = await listBooks(user.id, { limit: PAGE_LIMIT_DEFAULT });
  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <BookList initialPage={page} userId={user.id} />
    </div>
  );
}
