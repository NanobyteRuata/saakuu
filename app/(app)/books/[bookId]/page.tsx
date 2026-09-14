import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { COLUMN_TYPE_LABELS } from "@/lib/books/schemas";

import { loadBookPage } from "./data";

/** Table tab. Rows arrive with extraction (Phase 5+); for now it shows the output schema. */
export default async function BookTablePage({ params }: { params: Promise<{ bookId: string }> }) {
  const { book } = await loadBookPage((await params).bookId);
  return (
    <section aria-label="Output table" className="overflow-x-auto rounded-lg border">
      <table className="w-full min-w-max text-sm">
        <thead className="bg-muted/50">
          <tr>
            {book.columns.map((column) => (
              <th key={column.id} scope="col" className="border-b px-3 py-2 text-left align-bottom font-medium">
                <div className="flex flex-col gap-1">
                  <span>{column.label}</span>
                  <span className="text-muted-foreground flex items-center gap-1.5 text-xs font-normal">
                    <Badge variant="outline">{COLUMN_TYPE_LABELS[column.dataType]}</Badge>
                    <code>{column.key}</code>
                  </span>
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            <td colSpan={Math.max(book.columns.length, 1)} className="px-6 py-14 text-center">
              <p className="font-medium">No rows yet</p>
              <p className="text-muted-foreground mx-auto mt-1 max-w-md text-sm whitespace-normal">
                Rows appear here once a template has read your uploaded photos. You can change these columns any time in{" "}
                <Link href={`/books/${book.id}/settings`} className="underline underline-offset-4">
                  Settings
                </Link>
                .
              </p>
            </td>
          </tr>
        </tbody>
      </table>
    </section>
  );
}
