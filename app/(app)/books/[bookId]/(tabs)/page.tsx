import { LandingTabRedirect } from "@/components/books/landing-tab";
import { OutputTable } from "@/components/table/output-table";
import { getTableMeta, listRows } from "@/lib/table/service";
import { ROWS_PAGE_MAX } from "@/lib/table/schemas";

import { loadBookPage } from "../data";

/** Table tab (docs/05 §12): the output table. Later pages load in the browser. */
export default async function BookTablePage({ params }: { params: Promise<{ bookId: string }> }) {
  const { user, book } = await loadBookPage((await params).bookId);
  const [meta, firstPage] = await Promise.all([getTableMeta(user.id, book.id), listRows(user.id, book.id, { limit: ROWS_PAGE_MAX })]);
  return (
    <>
      <LandingTabRedirect bookId={book.id} userId={user.id} templateCount={book.templateCount} />
      <OutputTable key={book.id} meta={meta} firstPage={firstPage} />
    </>
  );
}
