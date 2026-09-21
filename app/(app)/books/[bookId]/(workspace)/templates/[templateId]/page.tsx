import { notFound } from "next/navigation";

import { TemplateEditor } from "@/components/templates/template-editor";
import { AppError } from "@/lib/errors";
import { getTemplate, type TemplateDetail } from "@/lib/templates/service";
import { idSchema } from "@/lib/validation";

import { loadBookPage } from "../../../data";

type Params = { params: Promise<{ bookId: string; templateId: string }> };

export default async function TemplateEditorPage({ params }: Params) {
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

  return <TemplateEditor initial={template} userId={user.id} bookDefaultModel={book.defaultModel} bookDateEra={book.dateEra} />;
}
