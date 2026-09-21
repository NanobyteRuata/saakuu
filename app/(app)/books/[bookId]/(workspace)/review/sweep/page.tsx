import type { Metadata } from "next";

import { ColumnSweep } from "@/components/review/column-sweep";
import { firstSweepColumn } from "@/lib/review/service";
import { ROWS_PAGE_MAX } from "@/lib/table/schemas";
import { getTableMeta, listRows } from "@/lib/table/service";
import { idSchema } from "@/lib/validation";

import { loadBookPage } from "../../../data";

type Params = { params: Promise<{ bookId: string }>; searchParams: Promise<{ column?: string | string[]; row?: string | string[] }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { book } = await loadBookPage((await params).bookId);
  return { title: `Column sweep · ${book.name} · SaaKuu` };
}

function asId(value: string | string[] | undefined): string | null {
  return typeof value === "string" && idSchema.safeParse(value).success ? value : null;
}

/**
 * Column sweep (docs/05 §13.1, docs/06 Phase 20), inside the Review workspace. `?column=` picks the column, else the
 * first with unreviewed values; `?row=` opens at a row, else the first whose value in that column is unreviewed.
 */
export default async function ColumnSweepPage({ params, searchParams }: Params) {
  const { user, book } = await loadBookPage((await params).bookId);
  const query = await searchParams;
  const asked = asId(query.column);
  // The default is read alongside, not after: an asked-for column that was deleted, or belongs to another book, opens it
  // rather than an empty sweep, and that is only known once the columns are in.
  const [meta, firstPage, fallback] = await Promise.all([
    getTableMeta(user.id, book.id),
    listRows(user.id, book.id, { limit: ROWS_PAGE_MAX }),
    firstSweepColumn(user.id, book.id),
  ]);
  const columnId = asked && meta.columns.some((c) => c.id === asked) ? asked : fallback;
  return <ColumnSweep key={book.id} meta={meta} firstPage={firstPage} userId={user.id} columnId={columnId ?? ""} startRowId={asId(query.row)} />;
}
