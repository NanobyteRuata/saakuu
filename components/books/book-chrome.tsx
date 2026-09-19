"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { BookNameEditor } from "@/components/books/book-name-editor";
import { BookTabs } from "@/components/books/book-tabs";
import { Button } from "@/components/ui/button";
import { plural } from "@/lib/format";

type Props = {
  bookId: string;
  userId: string;
  name: string;
  rowCount: number;
  columnCount: number;
  documentCount: number;
  hasUnreviewedCells: boolean;
  /** Rendered by the server layout, so the export dialog keeps its own data. */
  exportButton: ReactNode;
  children: ReactNode;
};

/**
 * The book header, or a single breadcrumb line while inside a template (docs/06 Phase 10). A template
 * editor needs the width for its field tree and mapping preview; the book chrome is not what the
 * operator is working on there.
 */
export function BookChrome({ bookId, userId, name, rowCount, columnCount, documentCount, hasUnreviewedCells, exportButton, children }: Props) {
  const pathname = usePathname();
  const root = `/books/${bookId}`;
  const inTemplate = pathname.startsWith(`${root}/templates/`);

  if (inTemplate) {
    return (
      <div className="mx-auto flex w-full max-w-[1800px] flex-col gap-4 px-4 py-6 sm:px-6">
        <Link href={`${root}/templates`} className="text-muted-foreground hover:text-foreground self-start text-sm">
          ← {name} · Templates
        </Link>
        {children}
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6">
      <div className="flex flex-col gap-3">
        <Link href="/books" className="text-muted-foreground hover:text-foreground self-start text-sm">
          ← Books
        </Link>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-col gap-1">
            <BookNameEditor bookId={bookId} name={name} />
            <p className="text-muted-foreground text-sm">
              {plural(rowCount, "row")} · {plural(columnCount, "column")} · {plural(documentCount, "document")}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {hasUnreviewedCells ? (
              <Button asChild variant="outline">
                <Link href={`${root}/review`}>Resume review</Link>
              </Button>
            ) : null}
            {exportButton}
          </div>
        </div>
        <BookTabs bookId={bookId} userId={userId} />
      </div>
      {children}
    </div>
  );
}
