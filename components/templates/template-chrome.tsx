"use client";

import { ChevronDown, Settings2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import type { DateEra } from "@/lib/books/schemas";
import type { TemplateDetail } from "@/lib/templates/service";
import { cn } from "@/lib/utils";

import { ConfigBadge, KindBadge } from "./badges";
import { DuplicateTemplateDialog } from "./duplicate-template-dialog";
import { TemplateHeaderForm } from "./template-header-form";

export type TemplateTab = "fields" | "mapping";

type Props = {
  template: TemplateDetail;
  bookDefaultModel: string;
  bookDateEra?: DateEra;
  active: TemplateTab;
  onTemplate: (template: TemplateDetail) => void;
  /**
   * Fields fills the frame with panes and scrolls inside them (Phase 15); Mapping still scrolls as
   * one page, so it says so.
   */
  scroll?: boolean;
  children: React.ReactNode;
};

/**
 * The template's own header and section links. Fields sits at the template root and Mapping has its
 * own route (docs/06 Phase 10, decision 62), so both are deep-linkable and survive the back button.
 *
 * The header is one fixed line and the workspace is everything below it. **Template settings are a
 * disclosure, not a header**: language, model, anchors, instructions and double extraction are six
 * hundred pixels of form that is touched once per template, and leaving it open took two thirds of
 * the viewport away from the photo and the tree — the opposite of what Phase 15 is for. Collapsed,
 * the line still carries the name and both badges, which is what is worth seeing while working.
 */
export function TemplateChrome({ template, bookDefaultModel, active, onTemplate, scroll = false, children }: Props) {
  const [duplicateOpen, setDuplicateOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const bookRoot = `/books/${template.bookId}`;
  const root = `${bookRoot}/templates/${template.id}`;
  const tabs = [
    { id: "fields" as const, label: "Fields", href: root },
    { id: "mapping" as const, label: "Mapping", href: `${root}/mapping` },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-col border-b">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2">
          <Link href={`${bookRoot}/templates`} className="text-muted-foreground hover:text-foreground shrink-0 text-sm">
            ← Templates
          </Link>
          <h2 className="min-w-0 truncate text-sm font-semibold">{template.name}</h2>
          <KindBadge kind={template.kind} />
          <ConfigBadge state={template.configState} />
          <nav aria-label="Template sections" className="flex gap-1">
            {tabs.map((t) => (
              <Link
                key={t.id}
                href={t.href}
                aria-current={active === t.id ? "page" : undefined}
                className={cn(
                  "rounded-md px-3 py-1 text-sm font-medium",
                  active === t.id ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {t.label}
              </Link>
            ))}
          </nav>
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            aria-expanded={settingsOpen}
            aria-controls="template-settings"
            onClick={() => setSettingsOpen((open) => !open)}
          >
            <Settings2 />
            Template settings
            <ChevronDown className={cn("transition-transform", settingsOpen && "rotate-180")} />
          </Button>
        </div>
        {settingsOpen ? (
          <div id="template-settings" className="max-h-[50vh] overflow-y-auto border-t px-4 py-3">
            <TemplateHeaderForm
              template={template}
              bookDefaultModel={bookDefaultModel}
              onSaved={onTemplate}
              onDuplicate={() => setDuplicateOpen(true)}
            />
          </div>
        ) : null}
      </div>

      {scroll ? <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div> : children}

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
