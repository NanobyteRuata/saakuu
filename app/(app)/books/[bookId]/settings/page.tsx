import type { ReactNode } from "react";

import { BookSettingsForm } from "@/components/books/book-settings-form";
import { DeleteBookButton } from "@/components/books/delete-book-button";
import { EditColumnsDialog } from "@/components/books/edit-columns-dialog";
import { ExportPrefsForm } from "@/components/books/export-prefs-form";
import { GlossaryEditor } from "@/components/books/glossary-editor";
import { Badge } from "@/components/ui/badge";
import { listGlossary } from "@/lib/books/glossary-service";
import { COLUMN_TYPE_LABELS } from "@/lib/books/schemas";
import { cn } from "@/lib/utils";
import { PAGE_LIMIT_DEFAULT } from "@/lib/validation";

import { loadBookPage } from "../data";

function Section({
  title,
  description,
  action,
  danger = false,
  children,
}: {
  title: string;
  description: string;
  action?: ReactNode;
  danger?: boolean;
  children: ReactNode;
}) {
  const id = `section-${title.toLowerCase().replace(/\s+/g, "-")}`;
  return (
    <section aria-labelledby={id} className={cn("flex flex-col gap-4 rounded-xl border p-5", danger && "border-destructive/40")}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 id={id} className={cn("text-lg font-semibold", danger && "text-destructive")}>
            {title}
          </h2>
          <p className="text-muted-foreground max-w-2xl text-sm">{description}</p>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

export default async function BookSettingsPage({ params }: { params: Promise<{ bookId: string }> }) {
  const { user, book } = await loadBookPage((await params).bookId);
  const glossary = await listGlossary(user.id, book.id, { limit: PAGE_LIMIT_DEFAULT });

  return (
    <div className="flex flex-col gap-6">
      <Section title="General" description="Name, default model, and how values are interpreted after extraction.">
        <BookSettingsForm
          key={book.updatedAt}
          book={{
            id: book.id,
            name: book.name,
            defaultModel: book.defaultModel,
            numeralSystem: book.numeralSystem,
            dateEra: book.dateEra,
            blankToken: book.blankToken,
            illegibleToken: book.illegibleToken,
            updatedAt: book.updatedAt,
          }}
        />
      </Section>

      <Section
        title="Output table"
        description="The columns of the spreadsheet you export, in order. Keys become the CSV headers."
        action={<EditColumnsDialog bookId={book.id} columns={book.columns} />}
      >
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-muted-foreground text-left text-xs">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">
                  Label
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Key
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Type
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Required
                </th>
              </tr>
            </thead>
            <tbody aria-label="Current columns">
              {book.columns.map((column) => (
                <tr key={column.id} className="border-t">
                  <td className="px-3 py-2">{column.label}</td>
                  <td className="px-3 py-2 font-mono">{column.key}</td>
                  <td className="px-3 py-2">
                    <Badge variant="outline">{COLUMN_TYPE_LABELS[column.dataType]}</Badge>
                    {column.dataType === "ENUM" ? (
                      <span className="text-muted-foreground font-value ml-2">{column.enumValues.join(", ")}</span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2">{column.isRequired ? "Yes" : "No"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section
        title="Glossary"
        description="Conventions your forms use, written in plain language. They're given to the AI with every extraction for this book."
      >
        <GlossaryEditor bookId={book.id} initial={glossary} />
      </Section>

      <Section title="Export preferences" description="How cells without a readable value appear in the exported CSV.">
        <ExportPrefsForm
          key={book.updatedAt}
          bookId={book.id}
          blankToken={book.blankToken}
          illegibleToken={book.illegibleToken}
        />
      </Section>

      <Section
        title="Danger zone"
        description="Deleting the book removes it, its templates, documents and rows from your books."
        danger
      >
        <div>
          <DeleteBookButton book={{ id: book.id, name: book.name }} />
        </div>
      </Section>
    </div>
  );
}
