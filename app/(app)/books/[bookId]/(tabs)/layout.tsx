import type { Metadata } from "next";
import type { ReactNode } from "react";

import { BookChrome } from "@/components/books/book-chrome";
import { ExportButton } from "@/components/export/export-dialog";

import { loadBookPage } from "../data";

type Params = { params: Promise<{ bookId: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { book } = await loadBookPage((await params).bookId);
  return { title: `${book.name} · SaaKuu` };
}

export default async function BookLayout({ children, params }: Params & { children: ReactNode }) {
  const { user, book } = await loadBookPage((await params).bookId);
  return (
    <BookChrome
      bookId={book.id}
      userId={user.id}
      name={book.name}
      rowCount={book.rowCount}
      columnCount={book.columns.length}
      documentCount={book.documentCount}
      hasUnreviewedCells={book.hasUnreviewedCells}
      exportButton={
        <ExportButton
          bookId={book.id}
          columns={book.columns.map((c) => ({ id: c.id, key: c.key, label: c.label }))}
          blankToken={book.blankToken}
          illegibleToken={book.illegibleToken}
          rowCount={book.rowCount}
        />
      }
    >
      {children}
    </BookChrome>
  );
}
