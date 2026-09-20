"use client";

import { Upload } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { FormMessage } from "@/components/auth/form-message";
import { UploadDialog, type TemplateOption } from "@/components/documents/upload-dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { getJson } from "@/lib/api-client";
import type { Page } from "@/lib/db/pagination";
import { MAX_TEMPLATES } from "@/lib/templates/schemas";
import type { TemplateSummary } from "@/lib/templates/service";

/**
 * Everything the app can honestly do below 1280px (docs/05 §0, decision 69): choose a template and
 * add photos. Standing at the filing cabinet with a phone is a real use; reading Burmese handwriting
 * at 400px is guesswork, so review, mapping and the table say so rather than rendering badly.
 *
 * Phase 18 gives this screen its full form — watch processing, done. This is the gate and the
 * intake, reusing the same upload component the Documents workspace uses.
 */
export function NarrowUpload({ bookId, name }: { bookId: string; name: string }) {
  const [templates, setTemplates] = useState<TemplateOption[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // One page, big enough for every template a book can have: a picker that silently drops
      // half the templates is worse than no picker.
      const result = await getJson<Page<TemplateSummary>>(`/api/books/${bookId}/templates?limit=${MAX_TEMPLATES}`);
      if (cancelled) return;
      if (!result.ok) {
        setLoadError(result.error.message);
        return;
      }
      const options = result.data.items.map((t) => ({ id: t.id, name: t.name, kind: t.kind }));
      setTemplates(options);
      setTemplateId((prev) => prev ?? options[0]?.id ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, [bookId]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-md flex-col gap-6 px-4 py-8">
        <div className="flex flex-col gap-1">
          <Link href="/books" className="text-muted-foreground hover:text-foreground self-start text-sm">
            ← Books
          </Link>
          <h1 className="text-xl font-semibold tracking-tight">{name}</h1>
          <p className="text-muted-foreground text-sm">
            On a phone this book can take photos. Reviewing what the AI read means comparing handwriting against the
            page, which needs a wider screen — open this book on a computer for that.
          </p>
        </div>

        {loadError ? (
          <FormMessage tone="error">{loadError}</FormMessage>
        ) : templates === null ? (
          <div className="bg-muted h-24 animate-pulse rounded-lg" aria-busy="true">
            <span className="sr-only">Loading templates…</span>
          </div>
        ) : templates.length === 0 ? (
          <div className="flex flex-col gap-2 rounded-lg border p-4">
            <p className="font-medium">No templates yet</p>
            <p className="text-muted-foreground text-sm">
              A template describes what is on the paper, and every photo is uploaded into one. Building it means reading
              the page beside the fields, so it is done on a computer.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3 rounded-lg border p-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="narrow-template">Template</Label>
              <Select value={templateId ?? undefined} onValueChange={setTemplateId}>
                <SelectTrigger id="narrow-template" className="w-full">
                  <SelectValue placeholder="Choose a template" />
                </SelectTrigger>
                <SelectContent>
                  {templates.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button onClick={() => setUploadOpen(true)} disabled={templateId === null}>
              <Upload />
              Add photos
            </Button>
          </div>
        )}

        {templates && templateId ? (
          <UploadDialog
            bookId={bookId}
            templates={templates}
            initialTemplateId={templateId}
            // The template is chosen on the screen behind the dialog; two pickers for one choice.
            lockTemplate
            open={uploadOpen}
            onOpenChange={setUploadOpen}
            onClosed={() => setUploadOpen(false)}
          />
        ) : null}
      </div>
    </div>
  );
}
