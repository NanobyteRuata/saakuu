import type { Metadata } from "next";

import { RowReview } from "@/components/review/row-review";
import { resumePoint } from "@/lib/review/service";
import { ROWS_PAGE_MAX } from "@/lib/table/schemas";
import { getTableMeta, listRows } from "@/lib/table/service";
import { idSchema } from "@/lib/validation";

import { loadBookPage } from "../../data";

type Params = { params: Promise<{ bookId: string }>; searchParams: Promise<{ row?: string | string[] }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { book } = await loadBookPage((await params).bookId);
  return { title: `Review · ${book.name} · SaaKuu` };
}

/**
 * The Review workspace (docs/05 §13), inside the book frame. `?row=` opens at that row; otherwise review resumes in the
 * document it stopped in (Phase 19), which is also where the nav and the books list's `Resume review` land.
 */
export default async function ReviewPage({ params, searchParams }: Params) {
  const { user, book } = await loadBookPage((await params).bookId);
  const { row } = await searchParams;
  const asked = typeof row === "string" && idSchema.safeParse(row).success ? row : null;
  const [meta, firstPage, resume] = await Promise.all([
    getTableMeta(user.id, book.id),
    listRows(user.id, book.id, { limit: ROWS_PAGE_MAX }),
    asked ? null : resumePoint(user.id, book.id),
  ]);
  return (
    <RowReview
      key={book.id}
      meta={meta}
      firstPage={firstPage}
      userId={user.id}
      startRowId={asked ?? resume?.rowId ?? null}
      resume={resume}
      exportSettings={{ columns: book.columns.map((c) => ({ id: c.id, key: c.key, label: c.label })), blankToken: book.blankToken, illegibleToken: book.illegibleToken }}
    />
  );
}
