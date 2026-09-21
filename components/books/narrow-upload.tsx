"use client";

import { Camera, Check, ImagePlus, Loader2, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { FormMessage } from "@/components/auth/form-message";
import type { TemplateOption } from "@/components/documents/upload-dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { getJson, postJson } from "@/lib/api-client";
import type { Page } from "@/lib/db/pagination";
import { plural } from "@/lib/format";
import { UPLOAD_ACCEPT, useIntakeUploads, type IntakeFile } from "@/lib/photos/use-intake-uploads";
import { fetchDocumentDetails, isPending, usePhotoProcessing } from "@/lib/photos/use-photo-processing";
import type { PhotoView } from "@/lib/photos/views";
import { MAX_TEMPLATES } from "@/lib/templates/schemas";
import type { TemplateSummary } from "@/lib/templates/service";

/** What an uploaded file became: one document, whose pages are its photos (a PDF has several). */
type Uploaded = { documentId: string; photoIds: string[] };

/**
 * Everything the app can honestly do below 1280px (docs/05 §0, decision 69), in its full form since
 * Phase 18: choose a template, shoot or pick, watch processing, done. Standing at the filing cabinet
 * with a phone is a real use; reading Burmese handwriting at 400px is guesswork, so review, mapping and
 * the table say so rather than rendering badly.
 *
 * Its own screen rather than the batch dialog: that dialog is built for grouping and reordering on a
 * wide screen, and on a phone it was a 6xl modal with a 288px template picker inside a page that had
 * already asked which template. One photo is one document here, one PDF is one document with its pages
 * in order; grouping is done later on a computer, where the pages can be seen side by side.
 */
export function NarrowUpload({ bookId, name }: { bookId: string; name: string }) {
  const [templates, setTemplates] = useState<TemplateOption[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [templateId, setTemplateId] = useState<string | null>(null);

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
          <PhoneIntake templates={templates} templateId={templateId} onTemplateChange={setTemplateId} />
        )}
      </div>
    </div>
  );
}

function PhoneIntake({
  templates,
  templateId,
  onTemplateChange,
}: {
  templates: TemplateOption[];
  templateId: string | null;
  onTemplateChange: (id: string) => void;
}) {
  // A new session per "Upload more": fresh file list, fresh batch, same template.
  const [session, setSession] = useState(0);
  const [finished, setFinished] = useState<{ documents: number; pages: number; processing: number } | null>(null);
  const template = templates.find((t) => t.id === templateId) ?? null;

  if (finished && template) {
    return (
      <div className="flex flex-col gap-3 rounded-lg border p-4" role="status">
        <p className="flex items-center gap-2 font-medium">
          <Check className="text-primary size-4" />
          {plural(finished.documents, "document")} added to {template.name}
        </p>
        <p className="text-muted-foreground text-sm">
          {/* A PDF is one placeholder until it is unpacked, so a page count is only stated once it is true. */}
          {finished.processing > 0
            ? "Some pages are still processing, which finishes on its own."
            : `${plural(finished.pages, "page")} uploaded.`}{" "}
          Open this book on a computer to extract them and check what the AI reads — review needs a wider screen than
          this one.
        </p>
        <Button
          variant="outline"
          onClick={() => {
            setFinished(null);
            setSession((n) => n + 1);
          }}
        >
          Upload more
        </Button>
      </div>
    );
  }

  return (
    <IntakeSession
      key={session}
      templates={templates}
      templateId={templateId}
      onTemplateChange={onTemplateChange}
      onDone={setFinished}
      onRestart={() => setSession((n) => n + 1)}
    />
  );
}

function IntakeSession({
  templates,
  templateId,
  onTemplateChange,
  onDone,
  onRestart,
}: {
  templates: TemplateOption[];
  templateId: string | null;
  onTemplateChange: (id: string) => void;
  onDone: (summary: { documents: number; pages: number; processing: number }) => void;
  /** Every file failed: nothing to finish, so the way on is a clean list. */
  onRestart: () => void;
}) {
  const [uploaded, setUploaded] = useState<Record<string, Uploaded>>({});
  const [photos, setPhotos] = useState<Record<string, PhotoView>>({});
  const cameraRef = useRef<HTMLInputElement>(null);
  const pickRef = useRef<HTMLInputElement>(null);
  const batchRef = useRef<Promise<string | null> | null>(null);
  const uploadedRef = useRef(uploaded);
  useEffect(() => {
    uploadedRef.current = uploaded;
  }, [uploaded]);

  function batchId(forTemplate: string): Promise<string | null> {
    batchRef.current ??= postJson<{ batchId: string }>("/api/uploads/batch", { templateId: forTemplate }).then((r) => {
      if (r.ok) return r.data.batchId;
      batchRef.current = null;
      return null;
    });
    return batchRef.current;
  }

  const intake = useIntakeUploads<{ documentId: string; photo: PhotoView }>({
    templateId,
    register: async ({ key, file }) => {
      if (!templateId) return { ok: false, error: { code: "VALIDATION", message: "Choose a template first." } };
      const batch = await batchId(templateId);
      return postJson<{ documentId: string; photo: PhotoView }>("/api/uploads/complete", {
        key,
        templateId,
        filename: file.name,
        ...(batch ? { batchId: batch } : {}),
      });
    },
    onRegistered: ({ documentId, photo }, _file, localId) => {
      setPhotos((prev) => ({ ...prev, [photo.id]: photo }));
      setUploaded((prev) => ({ ...prev, [localId]: { documentId, photoIds: [photo.id] } }));
    },
  });
  const { files, unfinished } = intake;

  // Leaving mid-upload asks, as the batch dialog does; finishing never does (Phase 15).
  useEffect(() => {
    if (unfinished === 0) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unfinished]);

  // A PDF's placeholder photo is replaced by one photo per page; reload its document to find them.
  usePhotoProcessing(photos, async (views, missing) => {
    setPhotos((prev) => {
      const next = { ...prev, ...Object.fromEntries(views.map((p) => [p.id, p])) };
      for (const id of missing) delete next[id];
      return next;
    });
    const entries = Object.entries(uploadedRef.current).filter(([, u]) => u.photoIds.some((id) => missing.includes(id)));
    const details = await fetchDocumentDetails([...new Set(entries.map(([, u]) => u.documentId))]);
    for (const detail of details.values()) {
      if (!detail) continue;
      setPhotos((prev) => ({ ...prev, ...Object.fromEntries(detail.photos.map((p) => [p.id, p])) }));
      setUploaded((prev) =>
        Object.fromEntries(
          Object.entries(prev).map(([localId, u]) => [localId, u.documentId === detail.id ? { ...u, photoIds: detail.photos.map((p) => p.id) } : u]),
        ),
      );
    }
  });

  const pick = (list: FileList | null) => {
    if (list && list.length > 0) intake.addFiles(list);
  };
  const livePhotos = Object.values(uploaded).flatMap((u) => u.photoIds.flatMap((id) => photos[id] ?? []));
  const documents = Object.keys(uploaded).length;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 rounded-lg border p-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="narrow-template">Template</Label>
          <Select value={templateId ?? undefined} onValueChange={onTemplateChange} disabled={files.length > 0}>
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
          {files.length > 0 ? (
            <p className="text-muted-foreground text-xs">These photos go into this template. Press Done to choose another.</p>
          ) : null}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Button className="h-16 flex-col gap-1" onClick={() => cameraRef.current?.click()} disabled={templateId === null}>
            <Camera />
            Take photo
          </Button>
          <Button variant="outline" className="h-16 flex-col gap-1" onClick={() => pickRef.current?.click()} disabled={templateId === null}>
            <ImagePlus />
            Choose files
          </Button>
        </div>
        {/* Two inputs: `capture` opens the camera straight away, which is exactly wrong for picking from the gallery. */}
        <input
          ref={cameraRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="sr-only"
          tabIndex={-1}
          aria-label="Take a photo"
          onChange={(e) => {
            pick(e.target.files);
            e.target.value = "";
          }}
        />
        <input
          ref={pickRef}
          type="file"
          accept={UPLOAD_ACCEPT}
          multiple
          className="sr-only"
          tabIndex={-1}
          aria-label="Choose photos or PDFs"
          onChange={(e) => {
            pick(e.target.files);
            e.target.value = "";
          }}
        />
        <p className="text-muted-foreground text-xs">
          Each photo becomes one document, and each PDF one document with its pages in order. Pages of a longer form can
          be grouped later on a computer.
        </p>
        {intake.error ? <FormMessage tone="error">{intake.error}</FormMessage> : null}
      </div>

      {files.length > 0 ? (
        <ul className="flex flex-col divide-y rounded-lg border" aria-label="Uploads">
          {files.map((f) => (
            <FileRow key={f.localId} file={f} photos={(uploaded[f.localId]?.photoIds ?? []).flatMap((id) => photos[id] ?? [])} />
          ))}
        </ul>
      ) : null}

      {files.length > 0 ? (
        <div className="flex items-center justify-between gap-3">
          <p className="text-muted-foreground text-sm" aria-live="polite">
            {unfinished > 0 ? `${plural(unfinished, "file")} uploading` : `${plural(documents, "document")} uploaded`}
          </p>
          {unfinished === 0 && documents === 0 ? (
            <Button variant="outline" onClick={onRestart}>
              Start over
            </Button>
          ) : (
            <Button
              disabled={unfinished > 0}
              onClick={() => onDone({ documents, pages: livePhotos.length, processing: livePhotos.filter(isPending).length })}
            >
              Done
            </Button>
          )}
        </div>
      ) : null}
    </div>
  );
}

function FileRow({ file, photos }: { file: IntakeFile; photos: PhotoView[] }) {
  const failedPhoto = photos.find((p) => p.status === "FAILED");
  const processing = photos.some(isPending);
  let status: { text: string; tone: "busy" | "done" | "error" };
  if (file.phase === "failed") status = { text: file.error ?? "Upload failed.", tone: "error" };
  else if (file.phase === "waiting") status = { text: "Waiting to upload", tone: "busy" };
  else if (file.phase === "uploading") status = { text: `Uploading ${Math.round(file.progress * 100)}%`, tone: "busy" };
  else if (file.phase === "registering" || photos.length === 0) status = { text: "Saving…", tone: "busy" };
  else if (failedPhoto) status = { text: failedPhoto.errorMessage ?? "This file couldn't be processed.", tone: "error" };
  else if (processing) status = { text: "Processing…", tone: "busy" };
  else status = { text: photos.length > 1 ? `Ready · ${plural(photos.length, "page")}` : "Ready", tone: "done" };

  return (
    <li className="flex items-center gap-3 px-3 py-2.5 text-sm">
      {status.tone === "done" ? (
        <Check className="text-primary size-4 shrink-0" aria-hidden />
      ) : status.tone === "error" ? (
        <TriangleAlert className="text-destructive size-4 shrink-0" aria-hidden />
      ) : (
        <Loader2 className="text-muted-foreground size-4 shrink-0 animate-spin" aria-hidden />
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{file.name}</span>
        <span className={status.tone === "error" ? "text-destructive text-xs" : "text-muted-foreground text-xs"}>{status.text}</span>
        {file.phase === "uploading" ? (
          <progress className="mt-1 h-1 w-full" max={1} value={file.progress} aria-label={`${file.name} upload progress`} />
        ) : null}
      </div>
    </li>
  );
}
