import { TemplateList } from "@/components/templates/template-list";
import { listTemplates } from "@/lib/templates/service";
import { PAGE_LIMIT_DEFAULT } from "@/lib/validation";

import { loadBookPage } from "../data";

export default async function BookTemplatesPage({ params }: { params: Promise<{ bookId: string }> }) {
  const { user, book } = await loadBookPage((await params).bookId);
  const page = await listTemplates(user.id, book.id, { limit: PAGE_LIMIT_DEFAULT });
  return <TemplateList bookId={book.id} initialPage={page} />;
}
