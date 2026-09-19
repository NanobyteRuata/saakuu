"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { FormMessage } from "@/components/auth/form-message";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { postJson } from "@/lib/api-client";
import { plural } from "@/lib/format";
import { MAX_UPLOAD_BYTES, UPLOAD_MIME_TYPES } from "@/lib/photos/schemas";
import { uploadMimeType, uploadToStorage } from "@/lib/photos/upload-client";
import type { PhotoView } from "@/lib/photos/views";

/** Replacing refuses PDFs server-side: a PDF is an import of several pages, not one page. */
const REPLACE_TYPES = UPLOAD_MIME_TYPES.filter((m) => m !== "application/pdf");

export type PageUploadTarget =
  | { kind: "replace"; photoId: string; page: number; rows: number; editedCells: number; reviewed: boolean }
  | { kind: "add" };

type Props = {
  target: PageUploadTarget | null;
  documentId: string;
  documentLabel: string | null;
  templateId: string;
  onOpenChange: (open: boolean) => void;
  onDone: (photo: PhotoView) => void;
};

/** Exact counts of what a replace keeps, per the confirmation rule in CLAUDE.md. */
function keptSentence(target: Extract<PageUploadTarget, { kind: "replace" }>): string {
  if (target.rows === 0) return "This document has no rows yet, so there is nothing to keep.";
  const kept = [plural(target.rows, "row")];
  if (target.editedCells > 0) kept.push(`${plural(target.editedCells, "cell")} you edited`);
  const subject = kept.length === 1 ? kept[0] : `${kept.slice(0, -1).join(", ")} and ${kept.at(-1)}`;
  const verb = kept.length === 1 && target.rows === 1 ? "is" : "are";
  return `Its ${subject} ${verb} kept${target.reviewed ? ", and so are your reviewed marks" : ""}.`;
}

/**
 * Re-shoots a page, or adds one to a document that was photographed incompletely (Phase 11, docs/05 §9).
 *
 * Replacing is stated in exact counts before the picker unlocks: the whole point is that it keeps the
 * rows, edits and reviewed marks that deleting the document would have thrown away (decision 59).
 */
export function PageUploadDialog({ target, documentId, documentLabel, templateId, onOpenChange, onDone }: Props) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const inflight = useRef<XMLHttpRequest | null>(null);
  const replacing = target?.kind === "replace";
  const accept = (replacing ? REPLACE_TYPES : UPLOAD_MIME_TYPES).join(",");

  useEffect(() => {
    if (target) {
      setBusy(false);
      setProgress(0);
      setError(null);
    }
  }, [target]);

  // Nothing should keep pushing a 25 MB photo at storage after this dialog is gone.
  useEffect(() => () => inflight.current?.abort(), []);

  async function pick(file: File | undefined) {
    if (!file || !target) return;
    if (file.size > MAX_UPLOAD_BYTES) {
      setError("Files can be at most 25 MB.");
      return;
    }
    if (!(replacing ? REPLACE_TYPES : UPLOAD_MIME_TYPES).includes(uploadMimeType(file) as (typeof UPLOAD_MIME_TYPES)[number])) {
      setError(replacing ? "Replace a page with a JPEG, PNG, WebP or HEIC photo." : "Only JPEG, PNG, WebP, HEIC and PDF files can be uploaded.");
      return;
    }
    setBusy(true);
    setError(null);
    const track = (xhr: XMLHttpRequest) => {
      inflight.current = xhr;
      return () => {
        inflight.current = null;
      };
    };
    const uploaded = await uploadToStorage(templateId, file, setProgress, track).catch(() => null);
    if (!uploaded) {
      setBusy(false);
      setError("The upload didn't finish. Check your connection and try again.");
      return;
    }
    if (!uploaded.ok) {
      setBusy(false);
      setError(uploaded.error.message);
      return;
    }
    const body = { key: uploaded.data.key, filename: file.name };
    const result = await postJson<{ photo: PhotoView }>(
      replacing ? `/api/photos/${target.photoId}/replace` : `/api/documents/${documentId}/pages`,
      body,
    );
    setBusy(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    toast.success(
      replacing
        ? `Page ${target.page} replaced. Extract this document again to read the new photo.`
        : "Page added. Extract this document again to read it.",
    );
    onDone(result.data.photo);
    onOpenChange(false);
  }

  return (
    <Dialog open={target !== null} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{replacing ? `Replace page ${target.page}` : "Add a page"}</DialogTitle>
          <DialogDescription>
            {replacing
              ? `Puts a new photo in place of page ${target.page} of “${documentLabel ?? "this document"}”.`
              : `Adds a page to the end of “${documentLabel ?? "this document"}”, for a form that was photographed incompletely.`}
          </DialogDescription>
        </DialogHeader>

        {replacing && target ? (
          <div className="text-sm">
            <p>{keptSentence(target)}</p>
            <p className="text-muted-foreground mt-1">
              The document is then marked <span className="text-foreground">Changed since last read</span>. Extract it again
              to read the new photo — your edits are kept and a new reading that differs is flagged instead of replacing them.
            </p>
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">
            The document is marked <span className="text-foreground">Changed since last read</span> so you can find it again.
            Extract it to read the new page.
          </p>
        )}

        {error ? <FormMessage tone="error">{error}</FormMessage> : null}
        {busy ? (
          <p className="text-muted-foreground text-sm" aria-live="polite">
            Uploading… {Math.round(progress * 100)}%
          </p>
        ) : null}

        <input
          ref={inputRef}
          type="file"
          accept={accept}
          className="sr-only"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            void pick(file);
          }}
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => inputRef.current?.click()} disabled={busy}>
            {busy ? "Uploading…" : "Choose a photo"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
