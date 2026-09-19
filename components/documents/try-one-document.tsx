"use client";

import Link from "next/link";
import { Upload } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { FormMessage } from "@/components/auth/form-message";
import { RegionImage } from "@/components/photo/region-image";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { getJson, postJson } from "@/lib/api-client";
import type { DocumentDetail, DocumentRawValues, DocumentSummary } from "@/lib/documents/service";
import type { Page } from "@/lib/db/pagination";
import type { ExtractionEstimate, ExtractionStatus } from "@/lib/extraction/service";
import { MAX_UPLOAD_BYTES, mimeTypeFromFilename, UPLOAD_MIME_TYPES } from "@/lib/photos/schemas";
import type { PhotoView } from "@/lib/photos/views";

/**
 * `Try one document` (docs/05 §6, §7, docs/06 Phase 10): upload or pick one document, read only that
 * one, and show what the AI made of it beside the photo. It is the trust moment — the first time
 * anyone sees a real reading — and it is also what fills the mapping preview, so one action answers
 * both. Nothing here is a new pipeline: it is the normal upload, the normal extraction of one
 * document, and the raw layer that reading writes.
 */

const POLL_MS = 2000;
/** Processing a page and reading it are both slow; give up explaining rather than spinning for ever. */
const MAX_WAIT_MS = 5 * 60 * 1000;

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

type Stage = "pick" | "uploading" | "processing" | "extracting" | "done";

const STAGE_LABEL: Record<Exclude<Stage, "pick" | "done">, string> = {
  uploading: "Uploading the photo…",
  processing: "Preparing the photo…",
  extracting: "Reading the page…",
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function TryOneDocument({ bookId, templateId, templateName, lang, open, onOpenChange, onExtracted }: Props) {
  const [stage, setStage] = useState<Stage>("pick");
  const [error, setError] = useState<string | null>(null);
  const [existing, setExisting] = useState<DocumentSummary[]>([]);
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DocumentDetail | null>(null);
  const [raw, setRaw] = useState<DocumentRawValues | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const cancelled = useRef(false);

  useEffect(() => {
    cancelled.current = false;
    return () => {
      cancelled.current = true;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    setStage("pick");
    setError(null);
    setDocumentId(null);
    setDetail(null);
    setRaw(null);
    void (async () => {
      const result = await getJson<Page<DocumentSummary>>(`/api/books/${bookId}/documents?templateId=${templateId}&limit=10`);
      if (result.ok) setExisting(result.data.items);
    })();
  }, [open, bookId, templateId]);

  const fail = useCallback((message: string) => {
    setError(message);
    setStage("pick");
  }, []);

  /**
   * Polls until the check says the step is done, or gives up with a message the operator can act on.
   * The check answers "done" / "keep waiting" / "give up, with this reason": a state update made
   * inside it is not visible to this loop, so the reason has to travel back through the result.
   */
  const waitFor = useCallback(
    async (check: () => Promise<"done" | "waiting" | { problem: string }>, timedOut: string): Promise<boolean> => {
      const until = Date.now() + MAX_WAIT_MS;
      for (;;) {
        if (cancelled.current) return false;
        const state = await check();
        if (state === "done") return true;
        if (state !== "waiting") {
          fail(state.problem);
          return false;
        }
        if (Date.now() > until) {
          fail(timedOut);
          return false;
        }
        await sleep(POLL_MS);
      }
    },
    [fail],
  );

  async function upload(file: File) {
    const mimeType = mimeTypeFromFilename(file.name) ?? (UPLOAD_MIME_TYPES.find((m) => m === file.type) ?? null);
    if (mimeType === null) {
      fail("Only JPEG, PNG, WebP, HEIC and PDF files can be uploaded.");
      return;
    }
    if (file.size === 0 || file.size > MAX_UPLOAD_BYTES) {
      fail(file.size === 0 ? "That file is empty." : "Files can be at most 25 MB.");
      return;
    }
    setError(null);
    setStage("uploading");
    const presigned = await postJson<{ key: string; url: string; headers: Record<string, string> }>("/api/uploads/presign", {
      templateId,
      filename: file.name,
      mimeType,
      byteSize: file.size,
    });
    if (!presigned.ok) return fail(presigned.error.message);

    const put = await fetch(presigned.data.url, { method: "PUT", headers: presigned.data.headers, body: file }).catch(() => null);
    if (!put || !put.ok) return fail("The photo couldn't be uploaded. Check your connection and try again.");

    const completed = await postJson<{ documentId: string; photo: PhotoView }>("/api/uploads/complete", {
      key: presigned.data.key,
      templateId,
      filename: file.name,
    });
    if (!completed.ok) return fail(completed.error.message);
    await run(completed.data.documentId);
  }

  /** Waits for the pages to be ready, reads the document, then shows what came back. */
  async function run(id: string) {
    setDocumentId(id);
    setStage("processing");
    const ready = await waitFor(async () => {
      const result = await getJson<DocumentDetail>(`/api/documents/${id}`);
      if (!result.ok) return "waiting";
      const photos = result.data.photos;
      const failed = photos.find((p) => p.status === "FAILED");
      if (failed) return { problem: failed.errorMessage ?? "That page couldn't be processed. Try a different photo." };
      setDetail(result.data);
      return photos.length > 0 && photos.every((p) => p.status === "DONE" && p.workingUrl !== null) ? "done" : "waiting";
    }, "The photo is taking longer than usual to prepare. It will appear on the Documents tab when it's ready.");
    if (!ready || cancelled.current) return;

    setStage("extracting");
    const estimate = await postJson<ExtractionEstimate>("/api/extractions/estimate", { documentIds: [id] });
    if (!estimate.ok) return fail(estimate.error.message);
    if (estimate.data.providerProblem !== null) return fail(estimate.data.providerProblem);
    if (estimate.data.extractable === 0) {
      return fail(estimate.data.blockers[0]?.reason ?? "This document can't be read right now.");
    }

    const started = await postJson<{ queued: number }>("/api/extractions/start", {
      documentIds: [id],
      model: estimate.data.model,
      nonce: crypto.randomUUID(),
    });
    if (!started.ok) return fail(started.error.message);

    // Only a finished state counts. `NEVER_RUN` is still waiting: the poll can outrun the run row
    // this document was just given, and reading its raw values then shows an empty page.
    const finished = await waitFor(async () => {
      const result = await getJson<ExtractionStatus[]>(`/api/extractions/status?documentIds=${id}`);
      const status = result.ok ? result.data[0] : undefined;
      if (status === undefined) return "waiting";
      if (status.runState === "FAILED") return { problem: "The page couldn't be read. The Documents tab can retry it." };
      return status.runState === "COMPLETE" || status.runState === "PARTIAL" ? "done" : "waiting";
    }, "The reading is taking longer than usual. It will finish on the Documents tab.");
    if (!finished || cancelled.current) return;

    const [values, fresh] = await Promise.all([
      getJson<DocumentRawValues>(`/api/documents/${id}/raw`),
      getJson<DocumentDetail>(`/api/documents/${id}`),
    ]);
    if (!values.ok) return fail(values.error.message);
    if (fresh.ok) setDetail(fresh.data);
    setRaw(values.data);
    setStage("done");
    onExtracted?.();
  }

  const photoOf = (photoId: string | null) => detail?.photos.find((p) => p.id === photoId) ?? detail?.photos[0] ?? null;
  const values = raw?.records.flatMap((r) => r.values.map((v) => ({ ...v, recordIndex: r.recordIndex }))) ?? [];
  const focused = values.find((v) => `${v.recordIndex}-${v.fieldId}` === focus) ?? null;
  const photo = photoOf(focused?.photoId ?? raw?.records[0]?.photoId ?? null);

  return (
    <Dialog open={open} onOpenChange={(next) => (stage === "uploading" || stage === "processing" || stage === "extracting" ? undefined : onOpenChange(next))}>
      <DialogContent className="sm:max-w-5xl" showCloseButton={stage === "pick" || stage === "done"}>
        <DialogHeader>
          <DialogTitle>Try one document</DialogTitle>
          <DialogDescription>
            Read a single page with “{templateName}” and see exactly what the AI makes of it, before spending anything on
            the rest. It also gives the mapping preview real values to work against.
          </DialogDescription>
        </DialogHeader>

        {stage === "pick" ? (
          <div className="flex flex-col gap-4">
            <p className="text-muted-foreground bg-muted/50 rounded-md border p-3 text-sm">
              On handwriting like this, expect to correct roughly half the cells. Correcting is still much faster than typing.
            </p>
            <input
              ref={fileRef}
              type="file"
              accept={UPLOAD_MIME_TYPES.join(",")}
              className="sr-only"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) void upload(file);
              }}
            />
            <Button type="button" onClick={() => fileRef.current?.click()} className="self-start">
              <Upload />
              Choose a photo
            </Button>
            {existing.length > 0 ? (
              <div className="flex flex-col gap-2">
                <p className="text-sm font-medium">Or read one you already uploaded</p>
                <ul className="max-h-48 divide-y overflow-y-auto rounded-md border text-sm" aria-label="Documents in this template">
                  {existing.map((doc) => (
                    <li key={doc.id} className="flex items-center justify-between gap-3 px-3 py-2">
                      <span lang={lang} className="font-value min-w-0 truncate">
                        {doc.label ?? "Untitled document"}
                      </span>
                      <Button type="button" size="sm" variant="outline" onClick={() => void run(doc.id)}>
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

        {stage === "uploading" || stage === "processing" || stage === "extracting" ? (
          <div className="flex flex-col gap-2 py-10 text-center" aria-live="polite">
            <p className="font-medium">{STAGE_LABEL[stage]}</p>
            <p className="text-muted-foreground text-sm">This usually takes under a minute. You can leave this open.</p>
          </div>
        ) : null}

        {stage === "done" && raw ? (
          <div className="grid gap-4 md:grid-cols-2">
            <div className="flex flex-col gap-2">
              {photo?.workingUrl ? (
                <RegionImage
                  url={photo.workingUrl}
                  alt={raw.label ?? "The page that was read"}
                  boxes={focused?.bbox ? [{ bbox: focused.bbox, tone: "active" }] : []}
                  zoom={1}
                  center={focused?.bbox ?? null}
                  className="max-h-[50vh] rounded-md border"
                />
              ) : (
                <p className="text-muted-foreground text-sm">The page is still rendering.</p>
              )}
            </div>
            <div className="flex max-h-[50vh] flex-col gap-2 overflow-y-auto">
              {values.length === 0 ? (
                <div>
                  <p className="font-medium">
                    {raw.contentState === "EMPTY" ? "This page looks blank" : "Nothing was read from this page"}
                  </p>
                  <p className="text-muted-foreground text-sm">
                    {raw.contentState === "EMPTY"
                      ? "That isn't a failure — a blank page reads as blank."
                      : "Check that the template matches this paper, or try a sharper photo."}
                  </p>
                </div>
              ) : (
                <>
                  <p className="text-muted-foreground text-sm">
                    {raw.totalRecords === 1 ? "1 row read" : `${raw.totalRecords} rows read`}
                    {raw.totalRecords > raw.records.length ? `, first ${raw.records.length} shown` : ""}. Hover a value to
                    find it on the page.
                  </p>
                  <ul className="divide-y rounded-md border text-sm">
                    {values.map((v) => {
                      const id = `${v.recordIndex}-${v.fieldId}`;
                      return (
                        <li
                          key={id}
                          onMouseEnter={() => setFocus(id)}
                          onFocus={() => setFocus(id)}
                          tabIndex={0}
                          className="flex items-baseline justify-between gap-3 px-3 py-1.5 outline-none focus-visible:bg-muted hover:bg-muted"
                        >
                          <span className="text-muted-foreground min-w-0 truncate" lang={lang}>
                            {v.path}
                          </span>
                          <span lang={lang} className="font-value min-w-0 truncate text-right">
                            {v.state === "ILLEGIBLE" ? "Couldn’t read" : (v.valueText ?? "—")}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
            </div>
          </div>
        ) : null}

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
