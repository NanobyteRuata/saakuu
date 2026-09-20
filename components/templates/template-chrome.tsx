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
  const bookRoot = `/books/${template.bookId}`;
  const root = `${bookRoot}/templates/${template.id}`;
  const tabs = [
    { id: "fields" as const, label: "Fields", href: root },
    { id: "mapping" as const, label: "Mapping", href: `${root}/mapping` },
  ];

  return (
    // A template is a page of the Templates workspace, so it scrolls inside the frame rather than
    // scrolling the page. The width cap is content width, not shell width: the field tree and the
    // properties form stop being readable side by side much past this (Phase 15 gives them panes).
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[1800px] flex-col gap-6 p-4">
        <Link href={`${bookRoot}/templates`} className="text-muted-foreground hover:text-foreground self-start text-sm">
          ← Templates
        </Link>

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
      </div>

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
