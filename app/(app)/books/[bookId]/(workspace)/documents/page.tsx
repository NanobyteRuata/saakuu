import { cookies } from "next/headers";

import { DocumentsView } from "@/components/documents/documents-view";
import { listDocumentsSchema } from "@/lib/documents/schemas";
import { legacyStatus } from "@/lib/documents/status";
import { readTimeZoneCookie, TIME_ZONE_COOKIE } from "@/lib/documents/time-zone";
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
  // A pre-Phase-18 bookmark still lands on the status it meant.
  const status = raw.status ?? legacyStatus(raw);
  // The upload day is the viewer's day; the Documents view keeps this cookie in step with the browser.
  const tz = readTimeZoneCookie((await cookies()).get(TIME_ZONE_COOKIE)?.value);
  // Unknown or malformed filters are dropped rather than failing the page.
  const schema = listDocumentsSchema.omit({ cursor: true });
  const parsed = schema.safeParse({ ...raw, status, tz });
  const filters = parsed.success ? parsed.data : schema.parse({ tz });
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
        status: filters.status ?? null,
        uploadedOn: filters.uploadedOn ?? null,
        sort: filters.sort,
        q: filters.q ?? "",
      }}
      timeZone={filters.tz}
      initialPage={page}
    />
  );
}
