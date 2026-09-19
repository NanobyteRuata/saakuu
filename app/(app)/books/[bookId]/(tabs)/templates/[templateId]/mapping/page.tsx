import { notFound } from "next/navigation";

import { MappingEditor } from "@/components/templates/mapping-editor";
import { AppError } from "@/lib/errors";
import { getTemplate, type TemplateDetail } from "@/lib/templates/service";
import { idSchema } from "@/lib/validation";

import { loadBookPage } from "../../../../data";

type Params = { params: Promise<{ bookId: string; templateId: string }> };

/** Mapping has its own route so it is deep-linkable and survives the back button (decision 62). */
export default async function TemplateMappingPage({ params }: Params) {
  const { bookId, templateId } = await params;
  const { user, book } = await loadBookPage(bookId);
  if (!idSchema.safeParse(templateId).success) notFound();

  let template: TemplateDetail;
  try {
    template = await getTemplate(user.id, templateId);
  } catch (err) {
    if (err instanceof AppError && err.code === "NOT_FOUND") notFound();
    throw err;
  }
  if (template.bookId !== book.id) notFound();

  return <MappingEditor initial={template} bookDefaultModel={book.defaultModel} />;
}
