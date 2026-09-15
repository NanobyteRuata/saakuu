"use client";

import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { arrayMove, horizontalListSortingStrategy, SortableContext, sortableKeyboardCoordinates, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Crop, GripVertical, Layers, PanelRightOpen, Split, Trash2, Upload } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { FormMessage } from "@/components/auth/form-message";
import { PhotoEditor } from "@/components/photo/photo-editor";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { getJson, postJson } from "@/lib/api-client";
import { formatBytes, PHOTO_STATUS_LABELS } from "@/lib/documents/labels";
import type { DocumentDetail } from "@/lib/documents/service";
import { plural } from "@/lib/format";
import { MAX_UPLOAD_BYTES, mimeTypeFromFilename, UPLOAD_MIME_TYPES } from "@/lib/photos/schemas";
import type { PhotoView } from "@/lib/photos/views";
import type { TemplateKind } from "@/lib/templates/schemas";
import { cn } from "@/lib/utils";

import { DeleteDocumentsDialog } from "./delete-documents-dialog";
import { DeletePhotoDialog } from "./delete-photo-dialog";
import { DocumentDrawer } from "./document-drawer";

export type TemplateOption = { id: string; name: string; kind: TemplateKind };

const PARALLEL_UPLOADS = 4;
const POLL_MS = 2000;
const STATUS_CHUNK = 200;

type FileItem = {
  localId: string;
  name: string;
  size: number;
  progress: number;
  phase: "waiting" | "uploading" | "registering" | "uploaded" | "failed";
  error: string | null;
};

type StagedDocument = { id: string; label: string; photoIds: string[] };

type Props = {
  bookId: string;
  templates: TemplateOption[];
  /** Pre-selected template, e.g. the Documents filter or the template card the dialog was opened from. */
  initialTemplateId: string | null;
  /** Opened from a template card: the template can't be changed. */
  lockTemplate?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The dialog closed; documents may have been created, grouped or deleted. */
  onClosed: () => void;
};

/** Photos still being processed, or edited and waiting for their new working copy (unless that failed). */
function isPending(p: PhotoView): boolean {
  return (p.status !== "DONE" && p.status !== "FAILED") || (p.status === "DONE" && !p.workingUrl && !p.errorMessage);
}

/**
 * Upload dialog (docs/05 §9). Each dropped file becomes its own document; select documents to group
 * them, drag pages to reorder, split, edit a page, delete a page or a document, or open the full
 * document drawer. Closing mid-upload asks first and stops unfinished uploads.
 */
export function UploadDialog({ templates, initialTemplateId, lockTemplate = false, open, onOpenChange, onClosed }: Props) {
  const unfinishedRef = useRef(0);
  const [confirmLeave, setConfirmLeave] = useState<number | null>(null);

  function requestClose(next: boolean) {
    if (next) return onOpenChange(true);
    if (unfinishedRef.current > 0) {
      setConfirmLeave(unfinishedRef.current);
      return;
    }
    onOpenChange(false);
    onClosed();
  }

  return (
    <>
      <Dialog open={open} onOpenChange={requestClose}>
        <DialogContent className="flex h-[calc(100vh-2rem)] max-w-[calc(100%-2rem)] flex-col gap-4 sm:max-w-6xl">
          {open ? (
            <UploadSession
              templates={templates}
              initialTemplateId={initialTemplateId}
              lockTemplate={lockTemplate}
              onUnfinishedChange={(n) => {
                unfinishedRef.current = n;
              }}
              onDone={() => requestClose(false)}
            />
          ) : null}
        </DialogContent>
      </Dialog>
      <AlertDialog open={confirmLeave !== null} onOpenChange={(next) => !next && setConfirmLeave(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop uploading?</AlertDialogTitle>
            <AlertDialogDescription>
              {plural(confirmLeave ?? 0, "file")} {confirmLeave === 1 ? "hasn't" : "haven't"} finished uploading. Leaving now
              stops {confirmLeave === 1 ? "it" : "them"}. Files that already finished stay as documents.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep uploading</AlertDialogCancel>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmLeave(null);
                unfinishedRef.current = 0;
                onOpenChange(false);
                onClosed();
              }}
            >
              Stop and close
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function putWithProgress(
  url: string,
  file: File,
  contentType: string,
  onProgress: (fraction: number) => void,
  track: (xhr: XMLHttpRequest) => () => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const untrack = track(xhr);
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", contentType);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      untrack();
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`storage responded ${xhr.status}`));
    };
    xhr.onerror = () => {
      untrack();
      reject(new Error("network"));
    };
    xhr.onabort = () => {
      untrack();
      reject(new Error("aborted"));
    };
    xhr.send(file);
  });
}

async function fetchDetails(ids: string[]): Promise<Map<string, DocumentDetail | null>> {
  const results = await Promise.all(ids.map((id) => getJson<DocumentDetail>(`/api/documents/${id}`)));
  return new Map(ids.map((id, i) => {
    const r = results[i];
    return [id, r?.ok ? r.data : null];
  }));
}

function UploadSession({
  templates,
  initialTemplateId,
  lockTemplate,
  onUnfinishedChange,
  onDone,
}: {
  templates: TemplateOption[];
  initialTemplateId: string | null;
  lockTemplate: boolean;
  onUnfinishedChange: (n: number) => void;
  onDone: () => void;
}) {
  const [templateId, setTemplateId] = useState<string | null>(
    initialTemplateId ?? (templates.length === 1 ? (templates[0]?.id ?? null) : null),
  );
  const [files, setFiles] = useState<FileItem[]>([]);
  const [documents, setDocuments] = useState<StagedDocument[]>([]);
  const [photos, setPhotos] = useState<Record<string, PhotoView>>({});
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [size, setSize] = useState<"small" | "medium">("medium");
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openDocumentId, setOpenDocumentId] = useState<string | null>(null);
  const [editing, setEditing] = useState<PhotoView | null>(null);
  const [deletingPhoto, setDeletingPhoto] = useState<{ photo: PhotoView; page: number } | null>(null);
  const [deletingDocument, setDeletingDocument] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const batchRef = useRef<Promise<string | null> | null>(null);
  const queueRef = useRef<{ item: FileItem; file: File; previous: Promise<void>; settle: () => void }[]>([]);
  const activeRef = useRef(0);
  // Registration runs in the order files were picked, so documents get their positions (the book's
  // manual order) in that order even though the bytes upload in parallel.
  const registerChainRef = useRef<Promise<void>>(Promise.resolve());
  const xhrsRef = useRef(new Set<XMLHttpRequest>());
  const stoppedRef = useRef(false);
  const documentsRef = useRef(documents);
  useEffect(() => {
    documentsRef.current = documents;
  }, [documents]);
  // Documents the drawer changed in place (label, page order, edits), refetched on resync.
  const dirtyRef = useRef(new Set<string>());
  // Bumped after every status poll so polling continues while the same photos stay pending.
  const [pollTick, setPollTick] = useState(0);

  const template = templates.find((t) => t.id === templateId) ?? null;
  const templateLocked = lockTemplate || files.length > 0;
  const unfinished = files.filter((f) => f.phase === "waiting" || f.phase === "uploading" || f.phase === "registering").length;

  useEffect(() => onUnfinishedChange(unfinished), [unfinished, onUnfinishedChange]);

  useEffect(() => {
    if (unfinished === 0) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unfinished]);

  // Closing the dialog stops unfinished uploads; files not yet registered never become documents.
  // The flag is reset on (re)mount because Strict Mode runs this cleanup once before the real mount.
  useEffect(() => {
    const xhrs = xhrsRef.current;
    stoppedRef.current = false;
    return () => {
      stoppedRef.current = true;
      queueRef.current = [];
      for (const xhr of xhrs) xhr.abort();
    };
  }, []);

  const patchFile = useCallback((localId: string, patch: Partial<FileItem>) => {
    setFiles((prev) => prev.map((f) => (f.localId === localId ? { ...f, ...patch } : f)));
  }, []);

  const replaceDocument = useCallback((detail: DocumentDetail) => {
    setPhotos((prev) => ({ ...prev, ...Object.fromEntries(detail.photos.map((p) => [p.id, p])) }));
    setDocuments((prev) =>
      prev.map((d) => (d.id === detail.id ? { id: d.id, label: detail.label ?? d.label, photoIds: detail.photos.map((p) => p.id) } : d)),
    );
  }, []);

  /**
   * Brings staged documents up to date after changes made in the drawer (split, page delete, document
   * delete, label or page order). One status call finds where every page now lives; only documents
   * that lost pages, gained pages, are new, or were changed in the drawer are refetched. Pages that
   * moved to a new document bring it in right after their old one.
   */
  const resync = useCallback(async () => {
    const docs = documentsRef.current;
    const photoIds = docs.flatMap((d) => d.photoIds);
    if (photoIds.length === 0) return;
    const views: PhotoView[] = [];
    for (let i = 0; i < photoIds.length; i += STATUS_CHUNK) {
      const result = await getJson<PhotoView[]>(`/api/photos/status?ids=${photoIds.slice(i, i + STATUS_CHUNK).join(",")}`);
      if (!result.ok) return;
      views.push(...result.data);
    }
    const viewById = new Map(views.map((v) => [v.id, v]));
    const known = new Set(docs.map((d) => d.id));
    const order: string[] = [];
    const refetch = new Set(dirtyRef.current);
    dirtyRef.current = new Set();
    for (const d of docs) {
      if (!order.includes(d.id)) order.push(d.id);
      for (const id of d.photoIds) {
        const v = viewById.get(id);
        if (!v) {
          refetch.add(d.id); // page deleted, or the whole document deleted
        } else if (v.documentId !== d.id) {
          refetch.add(d.id);
          refetch.add(v.documentId);
          if (!order.includes(v.documentId)) order.push(v.documentId);
        }
      }
    }
    for (const id of order) if (!known.has(id)) refetch.add(id);
    const details = await fetchDetails([...refetch]);
    const nextDocs: StagedDocument[] = [];
    const nextPhotos: Record<string, PhotoView> = {};
    for (const id of order) {
      if (refetch.has(id)) {
        const detail = details.get(id);
        if (!detail || detail.photos.length === 0) continue;
        nextDocs.push({ id, label: detail.label ?? "Untitled document", photoIds: detail.photos.map((p) => p.id) });
        for (const p of detail.photos) nextPhotos[p.id] = p;
      } else {
        const d = docs.find((doc) => doc.id === id);
        if (!d) continue;
        nextDocs.push(d);
        for (const pid of d.photoIds) {
          const v = viewById.get(pid);
          if (v) nextPhotos[pid] = v;
        }
      }
    }
    setDocuments(nextDocs);
    setPhotos(nextPhotos);
    const live = new Set(nextDocs.map((d) => d.id));
    setSelected((prev) => new Set([...prev].filter((id) => live.has(id))));
  }, []);

  function batchId(forTemplate: string): Promise<string | null> {
    batchRef.current ??= postJson<{ batchId: string }>("/api/uploads/batch", { templateId: forTemplate }).then((r) => {
      if (r.ok) return r.data.batchId;
      batchRef.current = null;
      return null;
    });
    return batchRef.current;
  }

  const trackXhr = useCallback((xhr: XMLHttpRequest) => {
    xhrsRef.current.add(xhr);
    return () => xhrsRef.current.delete(xhr);
  }, []);

  /** Uploads the bytes, then registers once every earlier-picked file has registered or failed. */
  async function uploadOne(forTemplate: string, item: FileItem, file: File, previous: Promise<void>) {
    if (stoppedRef.current) return;
    const mimeType = mimeTypeFromFilename(file.name) ?? file.type;
    patchFile(item.localId, { phase: "uploading" });
    const presign = await postJson<{ key: string; url: string }>("/api/uploads/presign", {
      templateId: forTemplate,
      filename: file.name,
      mimeType,
      byteSize: file.size,
    });
    if (!presign.ok) {
      patchFile(item.localId, { phase: "failed", error: presign.error.message });
      return;
    }
    try {
      await putWithProgress(presign.data.url, file, mimeType, (progress) => patchFile(item.localId, { progress }), trackXhr);
    } catch {
      patchFile(item.localId, { phase: "failed", error: "The upload was interrupted. Check your connection and try again." });
      return;
    }
    patchFile(item.localId, { phase: "registering", progress: 1 });
    await previous;
    if (stoppedRef.current) return;
    const batch = await batchId(forTemplate);
    const complete = await postJson<{ documentId: string; photo: PhotoView }>("/api/uploads/complete", {
      key: presign.data.key,
      templateId: forTemplate,
      filename: file.name,
      ...(batch ? { batchId: batch } : {}),
    });
    if (!complete.ok) {
      patchFile(item.localId, { phase: "failed", error: complete.error.message });
      return;
    }
    const { documentId, photo } = complete.data;
    patchFile(item.localId, { phase: "uploaded" });
    setPhotos((prev) => ({ ...prev, [photo.id]: photo }));
    setDocuments((prev) => (prev.some((d) => d.id === documentId) ? prev : [...prev, { id: documentId, label: file.name, photoIds: [photo.id] }]));
  }

  function pump(forTemplate: string) {
    while (activeRef.current < PARALLEL_UPLOADS && queueRef.current.length > 0) {
      const next = queueRef.current.shift();
      if (!next) break;
      activeRef.current += 1;
      void uploadOne(forTemplate, next.item, next.file, next.previous).finally(() => {
        next.settle();
        activeRef.current -= 1;
        pump(forTemplate);
      });
    }
  }

  function addFiles(list: FileList | File[]) {
    if (!templateId) return;
    setError(null);
    const accepted: { item: FileItem; file: File }[] = [];
    const rejected: string[] = [];
    for (const file of Array.from(list)) {
      const mime = mimeTypeFromFilename(file.name) ?? file.type;
      const item: FileItem = { localId: crypto.randomUUID(), name: file.name, size: file.size, progress: 0, phase: "waiting", error: null };
      if (!(UPLOAD_MIME_TYPES as string[]).includes(mime)) rejected.push(`${file.name}: only JPEG, PNG, WebP, HEIC and PDF files can be uploaded.`);
      else if (file.size > MAX_UPLOAD_BYTES) rejected.push(`${file.name}: files can be at most 25 MB.`);
      else if (file.size === 0) rejected.push(`${file.name}: this file is empty.`);
      else accepted.push({ item, file });
    }
    if (rejected.length > 0) setError(rejected.join(" "));
    setFiles((prev) => [...prev, ...accepted.map((a) => a.item)]);
    for (const a of accepted) {
      // A file registers after the previously picked file's upload has settled (registered or
      // failed), forming a chain in pick order.
      const previous = registerChainRef.current;
      let settle: () => void = () => undefined;
      registerChainRef.current = new Promise<void>((resolve) => {
        settle = resolve;
      });
      queueRef.current.push({ ...a, previous, settle });
    }
    pump(templateId);
  }

  // Poll processing state. A PDF placeholder disappears when its pages are created, so documents
  // with a missing photo are reloaded in full. Edited pages are polled until their new copy exists.
  const pendingKey = Object.values(photos)
    .filter(isPending)
    .map((p) => p.id)
    .join(",");
  useEffect(() => {
    if (!pendingKey) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const ids = pendingKey.split(",").slice(0, STATUS_CHUNK);
        const result = await getJson<PhotoView[]>(`/api/photos/status?ids=${ids.join(",")}`);
        if (!result.ok || cancelled) return;
        const seen = new Set(result.data.map((p) => p.id));
        const missing = ids.filter((id) => !seen.has(id));
        setPhotos((prev) => {
          const next = { ...prev, ...Object.fromEntries(result.data.map((p) => [p.id, p])) };
          for (const id of missing) delete next[id];
          return next;
        });
        const docsToReload = documentsRef.current.filter((d) => d.photoIds.some((id) => missing.includes(id))).map((d) => d.id);
        const details = await fetchDetails(docsToReload);
        if (cancelled) return;
        for (const detail of details.values()) if (detail) replaceDocument(detail);
      } finally {
        // Re-arm even when nothing changed or the request failed; the effect re-runs on the new tick.
        if (!cancelled) setPollTick((n) => n + 1);
      }
    }, POLL_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [pendingKey, pollTick, replaceDocument]);

  async function groupSelected() {
    if (!templateId) return;
    const chosen = documents.filter((d) => selected.has(d.id));
    const photoIds = chosen.flatMap((d) => d.photoIds);
    setBusy(true);
    const result = await postJson<{ documentId: string; removedDocuments: number }>(`/api/templates/${templateId}/documents`, { photoIds });
    if (!result.ok) {
      setBusy(false);
      toast.error(result.error.message);
      return;
    }
    const target = result.data.documentId;
    const merged = new Set(chosen.map((d) => d.id));
    setDocuments((prev) => prev.flatMap((d) => (d.id === target ? [{ ...d, photoIds }] : merged.has(d.id) ? [] : [d])));
    setSelected(new Set());
    const detail = await getJson<DocumentDetail>(`/api/documents/${target}`);
    if (detail.ok) replaceDocument(detail.data);
    setBusy(false);
    toast.success(`Grouped ${plural(photoIds.length, "photo")} into one document.`);
  }

  async function splitIntoPages(doc: StagedDocument) {
    setBusy(true);
    const created: StagedDocument[] = [];
    // Split the last page off repeatedly so each new document keeps paper order after the original.
    for (const photoId of [...doc.photoIds.slice(1)].reverse()) {
      const result = await postJson<{ documentId: string }>(`/api/documents/${doc.id}/split`, { photoIds: [photoId] });
      if (!result.ok) {
        toast.error(result.error.message);
        break;
      }
      created.unshift({ id: result.data.documentId, label: doc.label, photoIds: [photoId] });
    }
    const moved = new Set(created.map((c) => c.photoIds[0]));
    setDocuments((prev) =>
      prev.flatMap((d) => (d.id === doc.id ? [{ ...d, photoIds: d.photoIds.filter((p) => !moved.has(p)) }, ...created] : [d])),
    );
    setBusy(false);
  }

  async function reorderPages(doc: StagedDocument, photoIds: string[]) {
    const previous = doc.photoIds;
    setDocuments((prev) => prev.map((d) => (d.id === doc.id ? { ...d, photoIds } : d)));
    const result = await postJson<DocumentDetail>(`/api/documents/${doc.id}/reorder-photos`, { photoIds });
    if (!result.ok) {
      setDocuments((prev) => prev.map((d) => (d.id === doc.id ? { ...d, photoIds: previous } : d)));
      toast.error(result.error.message);
    }
  }

  function removeDocumentLocally(id: string) {
    setDocuments((prev) => prev.filter((d) => d.id !== id));
    setSelected((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }

  const uploadedCount = files.filter((f) => f.phase === "uploaded").length;
  const failedFiles = files.filter((f) => f.phase === "failed");
  const processing = Object.values(photos).filter((p) => p.status !== "DONE" && p.status !== "FAILED").length;

  return (
    <>
      <DialogHeader>
        <DialogTitle>Upload documents</DialogTitle>
        <DialogDescription>
          Each photo becomes its own document. Group the pages that belong to one record, and fix or remove any photo
          before you finish.
        </DialogDescription>
      </DialogHeader>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-1">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="upload-template">Template</Label>
            <Select value={templateId ?? undefined} onValueChange={setTemplateId} disabled={templateLocked}>
              <SelectTrigger id="upload-template" className="w-72">
                <SelectValue placeholder="Choose the kind of paper you're uploading" />
              </SelectTrigger>
              <SelectContent>
                {templates.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name} ({t.kind === "TABLE" ? "Table" : "Form"})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {templateLocked && !lockTemplate ? (
            <p className="text-muted-foreground pb-2 text-xs">To upload to another template, finish and start a new upload.</p>
          ) : null}
        </div>

        <div
          role="button"
          tabIndex={template ? 0 : -1}
          aria-disabled={!template}
          aria-label="Add photos or PDFs"
          onClick={() => template && inputRef.current?.click()}
          onKeyDown={(e) => {
            if (template && (e.key === "Enter" || e.key === " ")) {
              e.preventDefault();
              inputRef.current?.click();
            }
          }}
          onDragOver={(e) => {
            e.preventDefault();
            if (template) setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            addFiles(e.dataTransfer.files);
          }}
          className={cn(
            "focus-visible:ring-ring/50 flex flex-col items-center gap-2 rounded-xl border-2 border-dashed px-6 text-center outline-none focus-visible:ring-[3px]",
            documents.length > 0 ? "py-5" : "py-10",
            template ? "cursor-pointer" : "cursor-not-allowed opacity-60",
            dragOver && "border-primary bg-primary/5",
          )}
        >
          <Upload className="text-muted-foreground size-6" />
          {template ? (
            <>
              <p className="font-medium">Drop photos or PDFs here, or click to choose files</p>
              <p className="text-muted-foreground text-sm">
                To “{template.name}”. JPEG, PNG, WebP, HEIC or PDF, up to 25 MB each. Each PDF becomes one document.
              </p>
            </>
          ) : (
            <p className="font-medium">Choose a template first</p>
          )}
          <input
            ref={inputRef}
            type="file"
            multiple
            hidden
            accept=".jpg,.jpeg,.png,.webp,.heic,.heif,.pdf,image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf"
            onChange={(e) => {
              if (e.target.files) addFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </div>

        {error ? <FormMessage tone="error">{error}</FormMessage> : null}

        {files.length > 0 ? (
          <section aria-label="Upload progress" className="flex flex-col gap-2">
            <p className="text-sm" aria-live="polite">
              {uploadedCount} of {plural(files.length, "file")} uploaded
              {failedFiles.length > 0 ? ` · ${failedFiles.length} failed` : ""}
              {processing > 0 ? ` · ${plural(processing, "page")} processing` : ""}
            </p>
            {unfinished > 0 || failedFiles.length > 0 ? (
              <ul className="flex max-h-40 flex-col gap-1 overflow-y-auto rounded-lg border p-2 text-sm">
                {files
                  .filter((f) => f.phase !== "uploaded")
                  .map((f) => (
                    <li key={f.localId} className="flex items-center gap-3">
                      <span className="min-w-0 flex-1 truncate">{f.name}</span>
                      <span className="text-muted-foreground tabular-nums">{formatBytes(f.size)}</span>
                      {f.phase === "failed" ? (
                        <span className="text-destructive">{f.error}</span>
                      ) : (
                        <progress className="h-2 w-32" max={1} value={f.phase === "waiting" ? 0 : f.progress} aria-label={`${f.name} upload progress`} />
                      )}
                    </li>
                  ))}
              </ul>
            ) : null}
          </section>
        ) : null}

        {documents.length > 0 ? (
          <section aria-label="Uploaded documents" className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-medium">{plural(documents.length, "document")}</p>
              <div className="flex items-center gap-2">
                <div className="flex rounded-md border p-0.5 text-xs" role="group" aria-label="Photo size">
                  {(["small", "medium"] as const).map((s) => (
                    <button
                      key={s}
                      type="button"
                      aria-pressed={size === s}
                      onClick={() => setSize(s)}
                      className={cn("rounded px-2 py-1 capitalize", size === s ? "bg-muted font-medium" : "text-muted-foreground")}
                    >
                      {s}
                    </button>
                  ))}
                </div>
                <Button size="sm" variant="outline" disabled={selected.size < 2 || busy} onClick={groupSelected}>
                  <Layers />
                  Group into one document{selected.size >= 2 ? ` (${selected.size})` : ""}
                </Button>
              </div>
            </div>
            <ul
              className={cn(
                "grid gap-3",
                size === "small" ? "grid-cols-[repeat(auto-fill,minmax(9rem,1fr))]" : "grid-cols-[repeat(auto-fill,minmax(14rem,1fr))]",
              )}
            >
              {documents.map((doc) => (
                <StagedDocumentCard
                  key={doc.id}
                  doc={doc}
                  photos={photos}
                  size={size}
                  selected={selected.has(doc.id)}
                  busy={busy}
                  onSelect={(on) =>
                    setSelected((prev) => {
                      const next = new Set(prev);
                      if (on) next.add(doc.id);
                      else next.delete(doc.id);
                      return next;
                    })
                  }
                  onReorder={(ids) => reorderPages(doc, ids)}
                  onSplit={() => splitIntoPages(doc)}
                  onOpen={() => setOpenDocumentId(doc.id)}
                  onDelete={() => setDeletingDocument(doc.id)}
                  onEditPage={setEditing}
                  onDeletePage={(photo, page) => setDeletingPhoto({ photo, page })}
                />
              ))}
            </ul>
          </section>
        ) : null}
      </div>

      <div className="flex items-center justify-between gap-3 border-t pt-3">
        <p className="text-muted-foreground text-sm">
          {unfinished > 0 ? `${plural(unfinished, "file")} still uploading…` : documents.length > 0 ? "Everything is saved as you go." : ""}
        </p>
        <Button onClick={onDone} disabled={unfinished > 0}>
          Done
        </Button>
      </div>

      <DocumentDrawer
        documentId={openDocumentId}
        onOpenChange={(isOpen) => {
          if (isOpen) return;
          setOpenDocumentId(null);
          void resync();
        }}
        onChanged={(id) => dirtyRef.current.add(id)}
        onRemoved={(id) => {
          setOpenDocumentId(null);
          removeDocumentLocally(id);
        }}
      />
      {editing ? (
        <PhotoEditor
          photo={editing}
          open
          onOpenChange={(isOpen) => !isOpen && setEditing(null)}
          onSaved={(photo) => {
            setPhotos((prev) => ({ ...prev, [photo.id]: photo }));
            setEditing(null);
          }}
        />
      ) : null}
      <DeletePhotoDialog
        target={deletingPhoto}
        onOpenChange={(isOpen) => !isOpen && setDeletingPhoto(null)}
        onDeleted={({ documentDeleted }) => {
          const photoId = deletingPhoto?.photo.id;
          const documentId = deletingPhoto?.photo.documentId;
          if (!photoId || !documentId) return;
          if (documentDeleted) removeDocumentLocally(documentId);
          else setDocuments((prev) => prev.map((d) => (d.id === documentId ? { ...d, photoIds: d.photoIds.filter((p) => p !== photoId) } : d)));
        }}
      />
      <DeleteDocumentsDialog
        open={deletingDocument !== null}
        onOpenChange={(isOpen) => !isOpen && setDeletingDocument(null)}
        documentIds={deletingDocument ? [deletingDocument] : []}
        onDeleted={(ids) => ids.forEach(removeDocumentLocally)}
      />
    </>
  );
}

function StagedDocumentCard({
  doc,
  photos,
  size,
  selected,
  busy,
  onSelect,
  onReorder,
  onSplit,
  onOpen,
  onDelete,
  onEditPage,
  onDeletePage,
}: {
  doc: StagedDocument;
  photos: Record<string, PhotoView>;
  size: "small" | "medium";
  selected: boolean;
  busy: boolean;
  onSelect: (on: boolean) => void;
  onReorder: (photoIds: string[]) => void;
  onSplit: () => void;
  onOpen: () => void;
  onDelete: () => void;
  onEditPage: (photo: PhotoView) => void;
  onDeletePage: (photo: PhotoView, page: number) => void;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const multi = doc.photoIds.length > 1;

  function onDragEnd(e: DragEndEvent) {
    const from = doc.photoIds.indexOf(String(e.active.id));
    const to = e.over ? doc.photoIds.indexOf(String(e.over.id)) : -1;
    if (from < 0 || to < 0 || from === to) return;
    onReorder(arrayMove(doc.photoIds, from, to));
  }

  return (
    <li
      className={cn(
        "group flex flex-col gap-2 rounded-lg border p-2",
        selected && "border-primary ring-primary/30 ring-2",
        multi && size === "medium" && "col-span-2",
      )}
    >
      <div className="flex items-center gap-1.5">
        <Checkbox checked={selected} onCheckedChange={(c) => onSelect(c === true)} aria-label={`Select ${doc.label}`} />
        <button type="button" onClick={onOpen} className="min-w-0 flex-1 truncate text-left text-sm hover:underline" title={`Open ${doc.label}`}>
          {doc.label}
        </button>
        {multi ? <Badge variant="secondary">{plural(doc.photoIds.length, "page")}</Badge> : null}
        <Button size="icon" variant="ghost" className="size-7" onClick={onOpen} aria-label={`Open ${doc.label}`}>
          <PanelRightOpen />
        </Button>
        <Button size="icon" variant="ghost" className="size-7" onClick={onDelete} aria-label={`Delete ${doc.label}`}>
          <Trash2 />
        </Button>
      </div>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={doc.photoIds} strategy={horizontalListSortingStrategy}>
          <ol className="flex gap-2 overflow-x-auto pb-1" aria-label={`Pages of ${doc.label}`}>
            {doc.photoIds.map((id, i) => (
              <PageThumb
                key={id}
                id={id}
                index={i}
                label={doc.label}
                photo={photos[id]}
                size={size}
                draggable={multi && !busy}
                canDelete={multi}
                onEdit={onEditPage}
                onDelete={(photo) => onDeletePage(photo, i + 1)}
              />
            ))}
          </ol>
        </SortableContext>
      </DndContext>
      {multi ? (
        <Button size="sm" variant="ghost" className="self-start" onClick={onSplit} disabled={busy}>
          <Split />
          Split into single pages
        </Button>
      ) : null}
    </li>
  );
}

function PageThumb({
  id,
  index,
  label,
  photo,
  size,
  draggable,
  canDelete,
  onEdit,
  onDelete,
}: {
  id: string;
  index: number;
  label: string;
  photo: PhotoView | undefined;
  size: "small" | "medium";
  draggable: boolean;
  canDelete: boolean;
  onEdit: (photo: PhotoView) => void;
  onDelete: (photo: PhotoView) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id, disabled: !draggable });
  const box = size === "small" ? "h-28 w-24" : "h-44 w-36";
  const ready = photo?.status === "DONE";
  const page = index + 1;
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn("bg-muted relative flex shrink-0 items-center justify-center overflow-hidden rounded border", box, isDragging && "z-10 opacity-80 shadow-lg")}
    >
      {photo?.thumbUrl ? (
        <button
          type="button"
          className="h-full w-full"
          onClick={() => ready && onEdit(photo)}
          disabled={!ready}
          aria-label={`Edit page ${page} of ${label}`}
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- presigned storage URL, not an optimisable asset */}
          <img src={photo.thumbUrl} alt={`Page ${page}`} className="h-full w-full object-contain" />
        </button>
      ) : (
        <span className={cn("px-2 text-center text-xs", photo?.status === "FAILED" ? "text-destructive" : "text-muted-foreground")}>
          {photo ? (photo.status === "FAILED" ? (photo.errorMessage ?? PHOTO_STATUS_LABELS.FAILED) : `${PHOTO_STATUS_LABELS[photo.status]}…`) : "Processing…"}
        </span>
      )}
      <span className="bg-background/90 absolute bottom-1 left-1 rounded px-1 text-[10px] tabular-nums">p{page}</span>
      {photo && ready && !photo.workingUrl && !photo.errorMessage ? (
        <span className="bg-background/90 absolute right-1 bottom-1 rounded px-1 text-[10px]">updating…</span>
      ) : null}
      {photo && ready && photo.errorMessage ? (
        <span className="bg-destructive text-destructive-foreground absolute inset-x-1 bottom-1 rounded px-1 text-[10px]" title={photo.errorMessage}>
          Edit not applied — save again
        </span>
      ) : null}
      <div className="absolute top-1 right-1 flex gap-0.5 opacity-100 sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100">
        {photo && ready ? (
          <button type="button" className="bg-background/90 rounded p-0.5" onClick={() => onEdit(photo)} aria-label={`Crop or straighten page ${page} of ${label}`}>
            <Crop className="size-3.5" />
          </button>
        ) : null}
        {photo && canDelete ? (
          <button type="button" className="bg-background/90 rounded p-0.5" onClick={() => onDelete(photo)} aria-label={`Delete page ${page} of ${label}`}>
            <Trash2 className="size-3.5" />
          </button>
        ) : null}
        {draggable ? (
          <button type="button" className="bg-background/90 cursor-grab rounded p-0.5" aria-label={`Move page ${page}`} {...attributes} {...listeners}>
            <GripVertical className="size-3.5" />
          </button>
        ) : null}
      </div>
    </li>
  );
}
