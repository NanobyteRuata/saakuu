import { loadBookPage } from "../data";

export default async function BookTemplatesPage({ params }: { params: Promise<{ bookId: string }> }) {
  await loadBookPage((await params).bookId);
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed px-6 py-16 text-center">
      <p className="font-medium">No templates yet</p>
      <p className="text-muted-foreground max-w-md text-sm">
        A template describes one kind of paper form: the fields to read from it and which column each one fills.
        Creating templates is coming in the next update.
      </p>
    </div>
  );
}
