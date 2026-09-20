import { LandingWorkspaceRedirect } from "@/components/books/landing-workspace";
import { OutputTable } from "@/components/table/output-table";
import { getTableMeta, listRows } from "@/lib/table/service";
import { ROWS_PAGE_MAX } from "@/lib/table/schemas";

import { loadBookPage } from "../data";

/** The Result Table workspace (docs/05 §12). Later pages load in the browser. */
export default async function ResultTablePage({ params }: { params: Promise<{ bookId: string }> }) {
  const { user, book } = await loadBookPage((await params).bookId);
  const [meta, firstPage] = await Promise.all([getTableMeta(user.id, book.id), listRows(user.id, book.id, { limit: ROWS_PAGE_MAX })]);
  return (
    <>
      <LandingWorkspaceRedirect bookId={book.id} userId={user.id} templateCount={book.templateCount} />
      <OutputTable key={book.id} meta={meta} firstPage={firstPage} columns={book.columns} />
    </>
  );
}
