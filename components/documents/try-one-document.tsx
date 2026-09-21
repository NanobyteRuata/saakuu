"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { FormMessage } from "@/components/auth/form-message";
import { PhotoIntake } from "@/components/photo/photo-intake";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { getJson } from "@/lib/api-client";
import type { Page } from "@/lib/db/pagination";
import type { DocumentSummary } from "@/lib/documents/service";
import { READ_STAGE_LABEL, useReadOne } from "@/lib/extraction/use-read-one";

import { ERROR_RATE_LINE, ReadingResult } from "./reading-result";

/**
 * `Try one document` (docs/05 §6, §7, docs/06 Phase 10): upload or pick one document, read only that
 * one, and show what the AI made of it beside the photo. It is the trust moment — the first time
 * anyone sees a real reading — and it is also what fills the mapping preview, so one action answers
 * both.
 *
 * Since Phase 15 the parts are shared: the picker is the one photo intake, the reading is
 * `useReadOne`, and the result is `ReadingResult`. The template workspace drives the same two without
 * this dialog, because there the page is already on screen.
 */
type Props = {
  bookId: string;
  templateId: string;
  templateName: string;
  lang: string | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called once a reading finished, so the caller can reload a preview or a list. */
  onExtracted?: () => void;
};

export function TryOneDocument({ bookId, templateId, templateName, lang, open, onOpenChange, onExtracted }: Props) {
  const [existing, setExisting] = useState<DocumentSummary[]>([]);
  const [documentId, setDocumentId] = useState<string | null>(null);
  const reading = useReadOne(onExtracted);
  const { reset, read, stage, error, raw, detail } = reading;

  useEffect(() => {
    if (!open) return;
    setDocumentId(null);
    reset();
    void (async () => {
      const result = await getJson<Page<DocumentSummary>>(`/api/books/${bookId}/documents?templateId=${templateId}&limit=10`);
      if (result.ok) setExisting(result.data.items);
    })();
  }, [open, bookId, templateId, reset]);

  const busy = stage === "processing" || stage === "extracting";

  async function start(id: string) {
    setDocumentId(id);
    await read(id);
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (busy ? undefined : onOpenChange(next))}>
      <DialogContent className="sm:max-w-5xl" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>Try one document</DialogTitle>
          <DialogDescription>
            Read a single page with “{templateName}” and see exactly what the AI makes of it, before spending anything on the
            rest. It also gives the mapping preview real values to work against.
          </DialogDescription>
        </DialogHeader>

        {stage === "idle" ? (
          <div className="flex flex-col gap-4">
            <p className="text-muted-foreground bg-muted/50 rounded-md border p-3 text-sm">{ERROR_RATE_LINE}</p>
            <PhotoIntake
              mode={{ kind: "try", templateId, templateName }}
              onDone={(result) => result.kind === "document" && void start(result.documentId)}
            />
            {existing.length > 0 ? (
              <div className="flex flex-col gap-2">
                <p className="text-sm font-medium">Or read one you already uploaded</p>
                <ul className="max-h-48 divide-y overflow-y-auto rounded-md border text-sm" aria-label="Documents in this template">
                  {existing.map((doc) => (
                    <li key={doc.id} className="flex items-center justify-between gap-3 px-3 py-2">
                      <span lang={lang} className="font-value min-w-0 truncate">
                        {doc.label ?? "Untitled document"}
                      </span>
                      <Button type="button" size="sm" variant="outline" onClick={() => void start(doc.id)}>
                        Read this one
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {error ? <FormMessage tone="error">{error}</FormMessage> : null}
          </div>
        ) : null}

        {busy ? (
          <div className="flex flex-col gap-2 py-10 text-center" aria-live="polite">
            <p className="font-medium">{READ_STAGE_LABEL[stage]}</p>
            <p className="text-muted-foreground text-sm">This usually takes under a minute. You can leave this open.</p>
          </div>
        ) : null}

        {stage === "done" && raw ? <ReadingResult raw={raw} detail={detail} lang={lang} /> : null}

        {stage === "done" ? (
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Close
            </Button>
            <Button asChild>
              <Link href={`/books/${bookId}/templates/${templateId}/mapping`} onClick={() => onOpenChange(false)}>
                Map these values
              </Link>
            </Button>
          </DialogFooter>
        ) : null}
        {documentId && stage === "done" ? (
          <p className="text-muted-foreground text-xs">
            Saved as a document in{" "}
            <Link href={`/books/${bookId}/documents?templateId=${templateId}`} className="underline">
              Documents
            </Link>
            .
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
