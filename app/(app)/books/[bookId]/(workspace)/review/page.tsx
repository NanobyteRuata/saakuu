import type { Metadata } from "next";

import { RowReview } from "@/components/review/row-review";
import { ROWS_PAGE_MAX } from "@/lib/table/schemas";
import { getTableMeta, listRows } from "@/lib/table/service";
import { idSchema } from "@/lib/validation";

import { loadBookPage } from "../../data";

type Params = { params: Promise<{ bookId: string }>; searchParams: Promise<{ row?: string | string[] }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { book } = await loadBookPage((await params).bookId);
  return { title: `Review · ${book.name} · SaaKuu` };
}

/** The Review workspace (docs/05 §13), inside the book frame. `?row=` opens at that row. */
export default async function ReviewPage({ params, searchParams }: Params) {
  const { user, book } = await loadBookPage((await params).bookId);
  const { row } = await searchParams;
  const startRowId = typeof row === "string" && idSchema.safeParse(row).success ? row : null;
  const [meta, firstPage] = await Promise.all([getTableMeta(user.id, book.id), listRows(user.id, book.id, { limit: ROWS_PAGE_MAX })]);
  return (
    <RowReview
      key={book.id}
      meta={meta}
      firstPage={firstPage}
      userId={user.id}
      startRowId={startRowId}
      exportSettings={{ columns: book.columns.map((c) => ({ id: c.id, key: c.key, label: c.label })), blankToken: book.blankToken, illegibleToken: book.illegibleToken }}
    />
  );
}
