"use client";

import Link from "next/link";
import { useState } from "react";

import type { DateEra } from "@/lib/books/schemas";
import type { TemplateDetail } from "@/lib/templates/service";
import { cn } from "@/lib/utils";

import { DuplicateTemplateDialog } from "./duplicate-template-dialog";
import { TemplateHeaderForm } from "./template-header-form";

export type TemplateTab = "fields" | "mapping";

type Props = {
  template: TemplateDetail;
  bookDefaultModel: string;
  bookDateEra?: DateEra;
  active: TemplateTab;
  onTemplate: (template: TemplateDetail) => void;
  children: React.ReactNode;
};

/**
 * The template's own header and section links. Fields sits at the template root and Mapping has its
 * own route (docs/06 Phase 10, decision 62), so both are deep-linkable and survive the back button.
 */
export function TemplateChrome({ template, bookDefaultModel, active, onTemplate, children }: Props) {
  const [duplicateOpen, setDuplicateOpen] = useState(false);
  const root = `/books/${template.bookId}/templates/${template.id}`;
  const tabs = [
    { id: "fields" as const, label: "Fields", href: root },
    { id: "mapping" as const, label: "Mapping", href: `${root}/mapping` },
  ];

  return (
    <div className="flex flex-col gap-6">
      <TemplateHeaderForm
        template={template}
        bookDefaultModel={bookDefaultModel}
        onSaved={onTemplate}
        onDuplicate={() => setDuplicateOpen(true)}
      />

      <nav aria-label="Template sections" className="flex gap-1 border-b">
        {tabs.map((t) => (
          <Link
            key={t.id}
            href={t.href}
            aria-current={active === t.id ? "page" : undefined}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 text-sm font-medium",
              active === t.id ? "border-foreground text-foreground" : "text-muted-foreground hover:text-foreground border-transparent",
            )}
          >
            {t.label}
          </Link>
        ))}
      </nav>

      {children}

      <DuplicateTemplateDialog
        bookId={template.bookId}
        template={template}
        initialKind={template.kind === "FORM" ? "TABLE" : "FORM"}
        open={duplicateOpen}
        onOpenChange={setDuplicateOpen}
      />
    </div>
  );
}
