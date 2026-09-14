import type { Metadata } from "next";

export const metadata: Metadata = { title: "Books · SaaKuu" };

/** Placeholder until Phase 2 (Books & output table schema). */
export default function BooksPage() {
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight">Books</h1>
      <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed px-6 py-16 text-center">
        <p className="font-medium">You don&apos;t have any books yet.</p>
        <p className="text-muted-foreground max-w-md text-sm">
          A book is one project: the table you want to fill, the templates that describe your paper forms, and the photos
          you upload. Creating books is coming in the next update.
        </p>
      </div>
    </div>
  );
}
