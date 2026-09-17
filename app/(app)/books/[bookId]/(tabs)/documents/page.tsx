import { DocumentsView } from "@/components/documents/documents-view";
import { listDocumentsSchema } from "@/lib/documents/schemas";
import { listDocuments } from "@/lib/documents/service";
import { listTemplates, MAX_TEMPLATES } from "@/lib/templates/service";

import { loadBookPage } from "../../data";

type Props = {
  params: Promise<{ bookId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function BookDocumentsPage({ params, searchParams }: Props) {
  const { user, book } = await loadBookPage((await params).bookId);
  const raw = Object.fromEntries(
    Object.entries(await searchParams).flatMap(([k, v]) => (typeof v === "string" && v !== "" ? [[k, v]] : [])),
  );
  // Unknown or malformed filters are dropped rather than failing the page.
  const parsed = listDocumentsSchema.omit({ cursor: true }).safeParse(raw);
  const filters = parsed.success ? parsed.data : listDocumentsSchema.omit({ cursor: true }).parse({});
  const [templates, page] = await Promise.all([
    listTemplates(user.id, book.id, { limit: MAX_TEMPLATES }),
    listDocuments(user.id, book.id, filters),
  ]);
  return (
    <DocumentsView
      key={JSON.stringify(filters)}
      bookId={book.id}
      templates={templates.items.map((t) => ({ id: t.id, name: t.name, kind: t.kind }))}
      filters={{
        templateId: filters.templateId ?? null,
        runState: filters.runState ?? null,
        needsReview: filters.needsReview ?? null,
        hasEdits: filters.hasEdits ?? null,
        reviewed: filters.reviewed ?? null,
        q: filters.q ?? "",
      }}
      initialPage={page}
    />
  );
}
