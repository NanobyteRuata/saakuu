import { loadBookPage } from "../data";

export default async function BookDocumentsPage({ params }: { params: Promise<{ bookId: string }> }) {
  await loadBookPage((await params).bookId);
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed px-6 py-16 text-center">
      <p className="font-medium">No documents yet</p>
      <p className="text-muted-foreground max-w-md text-sm">
        Documents are the photos of your paper forms, grouped so that each document is one record. You&apos;ll upload
        them to a template once templates are available.
      </p>
    </div>
  );
}
