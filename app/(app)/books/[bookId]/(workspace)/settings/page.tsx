import type { ReactNode } from "react";

import { DeleteBookButton } from "@/components/books/delete-book-button";
import { GlossaryEditor } from "@/components/books/glossary-editor";
import { ValidationRulesEditor } from "@/components/books/validation-rules-editor";
import { PageScroll } from "@/components/shell/page-scroll";
import { listGlossary } from "@/lib/books/glossary-service";
import { cn } from "@/lib/utils";
import { PAGE_LIMIT_DEFAULT } from "@/lib/validation";
import { listRules } from "@/lib/validation/rules-service";

import { loadBookPage } from "../../data";

function Section({
  title,
  description,
  danger = false,
  children,
}: {
  title: string;
  description: string;
  danger?: boolean;
  children: ReactNode;
}) {
  const id = `section-${title.toLowerCase().replace(/\s+/g, "-")}`;
  return (
    <section aria-labelledby={id} className={cn("flex flex-col gap-4 rounded-xl border p-5", danger && "border-destructive/40")}>
      <div className="flex flex-col gap-1">
        <h2 id={id} className={cn("text-lg font-semibold", danger && "text-destructive")}>
          {title}
        </h2>
        <p className="text-muted-foreground max-w-2xl text-sm">{description}</p>
      </div>
      {children}
    </section>
  );
}

/**
 * Settings (docs/05 §5). Three sections since Phase 14: everything else was a question asked of the
 * operator instead of answered for them. The book's name is edited in the header, the output columns
 * on the Result Table and in Mapping, the export tokens in the export dialog, and the numeral system
 * and era are offered on the column whose values won't parse (decision 76).
 */
export default async function BookSettingsPage({ params }: { params: Promise<{ bookId: string }> }) {
  const { user, book } = await loadBookPage((await params).bookId);
  const [glossary, rules] = await Promise.all([listGlossary(user.id, book.id, { limit: PAGE_LIMIT_DEFAULT }), listRules(user.id, book.id, { counts: false })]);

  return (
    <PageScroll className="p-4">
      <div className="mx-auto flex max-w-4xl flex-col gap-6">
        <Section
          title="Glossary"
          description="Conventions your forms use, written in plain language. They're given to the AI with every extraction for this book."
        >
          <GlossaryEditor bookId={book.id} initial={glossary} />
        </Section>

        <Section
          title="Validation rules"
          description="Checks run on every cell of a column. Failing cells are flagged in the table with the reason; nothing is blocked."
        >
          <ValidationRulesEditor bookId={book.id} columns={book.columns.map((c) => ({ id: c.id, label: c.label, dataType: c.dataType }))} initial={rules} />
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
    </PageScroll>
  );
}
