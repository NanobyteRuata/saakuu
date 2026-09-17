import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import { BookNameEditor } from "@/components/books/book-name-editor";
import { BookTabs } from "@/components/books/book-tabs";
import { ExportButton } from "@/components/export/export-dialog";
import { plural } from "@/lib/format";

import { loadBookPage } from "../data";

type Params = { params: Promise<{ bookId: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { book } = await loadBookPage((await params).bookId);
  return { title: `${book.name} · SaaKuu` };
}

export default async function BookLayout({ children, params }: Params & { children: ReactNode }) {
  const { book } = await loadBookPage((await params).bookId);
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6">
      <div className="flex flex-col gap-3">
        <Link href="/books" className="text-muted-foreground hover:text-foreground self-start text-sm">
          ← Books
        </Link>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-col gap-1">
            <BookNameEditor bookId={book.id} name={book.name} />
            <p className="text-muted-foreground text-sm">
              {plural(book.rowCount, "row")} · {plural(book.columns.length, "column")} · {plural(book.documentCount, "document")}
            </p>
          </div>
          <ExportButton
            bookId={book.id}
            columns={book.columns.map((c) => ({ id: c.id, key: c.key, label: c.label }))}
            blankToken={book.blankToken}
            illegibleToken={book.illegibleToken}
            rowCount={book.rowCount}
          />
        </div>
        <BookTabs bookId={book.id} />
      </div>
      {children}
    </div>
  );
}
