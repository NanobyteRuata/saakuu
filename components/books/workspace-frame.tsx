"use client";

import Link from "next/link";
import type { ReactNode } from "react";

import { BookNameEditor } from "@/components/books/book-name-editor";
import { BookNav } from "@/components/books/book-nav";
import { NarrowUpload } from "@/components/books/narrow-upload";
import type { BookCounts } from "@/lib/books/service";
import { useLayoutTarget } from "@/lib/ui/breakpoint";

type Props = {
  bookId: string;
  userId: string;
  name: string;
  counts: BookCounts;
  /** Rendered by the server layout, so the export dialog keeps its own data. */
  exportButton: ReactNode;
  children: ReactNode;
};

/**
 * The book frame (docs/05 §0 and §4, decision 67). A workspace is a mode with its own layout, not a
 * view of a record — the same reason a video editor has pages rather than tabs — so this is one
 * header line and then the workspace filling everything below it. Nothing here scrolls; panes do.
 *
 * The header carries no counts of its own: the nav's are the same numbers, and `Review N left` goes
 * where `Resume review` used to. The shorter this line is, the more of the screen the photo gets.
 */
export function WorkspaceFrame({ bookId, userId, name, counts, exportButton, children }: Props) {
  const layout = useLayoutTarget();

  // Below 1280 the workspace is replaced rather than hidden, so a phone never mounts the virtualised
  // output table or its row fetches (decision 69). The server-rendered children still travel in the
  // payload. Phase 18 kept this gate instead of giving the phone a route: every book URL — a link
  // sent from a computer, a bookmark, the back button — lands on the upload screen here, where a
  // route of its own would have needed a redirect in each direction, keyed on a width the server
  // cannot see.
  if (layout === "narrow") return <NarrowUpload bookId={bookId} name={name} />;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-2">
        <div className="flex min-w-0 items-center gap-3">
          <Link href="/books" className="text-muted-foreground hover:text-foreground shrink-0 text-sm">
            ← Books
          </Link>
          <BookNameEditor bookId={bookId} name={name} className="text-base md:text-base" />
        </div>
        <BookNav bookId={bookId} userId={userId} initialCounts={counts} />
        <div className="ml-auto flex shrink-0 items-center gap-2">{exportButton}</div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
