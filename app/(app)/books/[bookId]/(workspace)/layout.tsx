import type { Metadata } from "next";
import type { ReactNode } from "react";

import { WorkspaceFrame } from "@/components/books/workspace-frame";
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
    <WorkspaceFrame
      bookId={book.id}
      userId={user.id}
      name={book.name}
      // Loaded with the book, so the nav's numbers are on screen at first paint; it refreshes them
      // on navigation and polls them while a run is active (docs/06 Phase 13).
      counts={book.counts}
      exportButton={
        <ExportButton
          bookId={book.id}
          columns={book.columns.map((c) => ({ id: c.id, key: c.key, label: c.label }))}
          blankToken={book.blankToken}
          illegibleToken={book.illegibleToken}
          rowCount={book.counts.rows}
        />
      }
    >
      {children}
    </WorkspaceFrame>
  );
}
