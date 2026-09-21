"use client";

import { Copy, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { FormMessage } from "@/components/auth/form-message";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { getJson } from "@/lib/api-client";
import { readLastWorkspace } from "@/lib/books/landing-workspace";
import type { BookSummary } from "@/lib/books/service";
import type { Page } from "@/lib/db/pagination";
import { formatCount, isoDate, plural } from "@/lib/format";

import { CopyBookDialog } from "./copy-book-dialog";
import { DeleteBooksDialog } from "./delete-books-dialog";

export function BookList({ initialPage, userId }: { initialPage: Page<BookSummary>; userId: string }) {
  const router = useRouter();
  const [books, setBooks] = useState(initialPage.items);
  const [nextCursor, setNextCursor] = useState(initialPage.nextCursor);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [toCopy, setToCopy] = useState<BookSummary | null>(null);
  /**
   * Each book opens on the workspace it was last used in (docs/06 Phase 10 and 13, decision 60).
   * Resolved after mount, because `localStorage` is not readable while rendering on the server;
   * until then, and whenever storage is empty or unreadable, the links point at the book itself.
   */
  const [lastWorkspace, setLastWorkspace] = useState<Record<string, string>>({});
  useEffect(() => {
    const found: Record<string, string> = {};
    for (const book of books) {
      const workspace = readLastWorkspace(userId, book.id);
      if (workspace !== null && workspace !== "") found[book.id] = workspace;
    }
    setLastWorkspace(found);
  }, [books, userId]);

  const selectedBooks = books.filter((b) => selected.has(b.id));
  const allSelected = books.length > 0 && selectedBooks.length === books.length;

  function toggle(id: string, on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function loadMore() {
    if (!nextCursor) return;
    setLoadingMore(true);
    setLoadError(null);
    const result = await getJson<Page<BookSummary>>(`/api/books?cursor=${encodeURIComponent(nextCursor)}`);
    setLoadingMore(false);
    if (!result.ok) {
      setLoadError(result.error.message);
      return;
    }
    setBooks((prev) => [...prev, ...result.data.items]);
    setNextCursor(result.data.nextCursor);
  }

  function onDeleted(ids: string[]) {
    const gone = new Set(ids);
    setBooks((prev) => prev.filter((b) => !gone.has(b.id)));
    setSelected(new Set());
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Books</h1>
        <Button asChild>
          <Link href="/books/new">
            <Plus />
            Create Book
          </Link>
        </Button>
      </div>

      {books.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-16 text-center">
          <p className="font-medium">You don&apos;t have any books yet.</p>
          <p className="text-muted-foreground max-w-md text-sm">
            A book is one project: the spreadsheet you want to fill, plus the templates and photos that fill it. Start
            by naming it and listing the columns you want to export.
          </p>
          <Button asChild variant="outline">
            <Link href="/books/new">Create your first book</Link>
          </Button>
        </div>
      ) : (
        <>
          {selected.size > 0 ? (
            <div
              role="region"
              aria-label="Selection"
              className="bg-muted sticky top-16 z-10 flex items-center justify-between gap-3 rounded-lg px-4 py-2 text-sm"
            >
              <span>{plural(selected.size, "book")} selected</span>
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
                  Clear selection
                </Button>
                <Button variant="destructive" size="sm" onClick={() => setDeleteOpen(true)}>
                  <Trash2 />
                  Delete ({selected.size})
                </Button>
              </div>
            </div>
          ) : null}

          <div className="rounded-lg border">
            <div className="text-muted-foreground flex items-center gap-3 border-b px-4 py-2 text-xs">
              <Checkbox
                checked={allSelected ? true : selected.size > 0 ? "indeterminate" : false}
                onCheckedChange={(checked) => setSelected(checked === true ? new Set(books.map((b) => b.id)) : new Set())}
                aria-label="Select all books"
              />
              <span>Name</span>
            </div>
            <ul aria-label="Your books">
              {books.map((book) => (
                <li key={book.id} className="hover:bg-muted/40 flex items-center gap-3 border-b px-4 py-3 last:border-b-0">
                  <Checkbox
                    checked={selected.has(book.id)}
                    onCheckedChange={(checked) => toggle(book.id, checked === true)}
                    aria-label={`Select ${book.name}`}
                  />
                  <div className="min-w-0 flex-1">
                    <Link
                      href={lastWorkspace[book.id] ? `/books/${book.id}/${lastWorkspace[book.id]}` : `/books/${book.id}`}
                      className="block truncate font-medium hover:underline"
                    >
                      {book.name}
                    </Link>
                    <p className="text-muted-foreground text-sm">
                      {plural(book.columnCount, "column")} · {plural(book.documentCount, "document")} ·{" "}
                      {plural(book.rowCount, "row")}
                    </p>
                  </div>
                  <ReviewProgress book={book} />
                  <span className="text-muted-foreground hidden text-sm tabular-nums sm:inline">
                    Updated {isoDate(book.updatedAt)}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`New book from ${book.name}`}
                    title="New book from this one"
                    onClick={() => setToCopy(book)}
                  >
                    <Copy />
                  </Button>
                </li>
              ))}
            </ul>
          </div>

          {loadError ? <FormMessage tone="error">{loadError}</FormMessage> : null}
          {nextCursor ? (
            <Button variant="outline" className="self-center" onClick={loadMore} disabled={loadingMore}>
              {loadingMore ? "Loading…" : "Load more books"}
            </Button>
          ) : null}
        </>
      )}

      <CopyBookDialog book={toCopy} open={toCopy !== null} onOpenChange={(open) => !open && setToCopy(null)} />
      <DeleteBooksDialog open={deleteOpen} onOpenChange={setDeleteOpen} books={selectedBooks} onDeleted={onDeleted} />
    </div>
  );
}

/**
 * Reviewed-of-total and a way straight back in (docs/06 Phase 17). `Resume review` opens the Review workspace,
 * which starts at the first unreviewed cell of the review queue, so returning costs neither a book open nor a
 * table load.
 */
function ReviewProgress({ book }: { book: BookSummary }) {
  if (book.cells === 0) return null;
  const left = book.cells - book.reviewedCells;
  const percent = Math.floor((book.reviewedCells / book.cells) * 100);
  return (
    <div className="flex shrink-0 items-center gap-3">
      <div className="flex w-44 flex-col gap-1">
        <span className="text-muted-foreground text-xs tabular-nums">
          {formatCount(book.reviewedCells)} of {plural(book.cells, "cell")} reviewed
        </span>
        <div
          className="bg-muted h-1.5 overflow-hidden rounded-full"
          role="progressbar"
          aria-label={`${book.name} review progress`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <div className="bg-primary h-full" style={{ width: `${percent}%` }} />
        </div>
      </div>
      {/* One slot for both states, so the bars line up down the list whichever a row shows. */}
      <div className="flex w-32 justify-end">
        {left > 0 ? (
          <Button asChild size="sm" variant="outline">
            <Link href={`/books/${book.id}/review`}>Resume review</Link>
          </Button>
        ) : (
          <span className="text-muted-foreground text-sm">All reviewed</span>
        )}
      </div>
    </div>
  );
}
