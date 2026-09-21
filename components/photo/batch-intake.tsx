"use client";

import { Layers } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { FormMessage } from "@/components/auth/form-message";
import { DeleteDocumentsDialog } from "@/components/documents/delete-documents-dialog";
import { DeletePhotoDialog } from "@/components/documents/delete-photo-dialog";
import { DocumentDrawer } from "@/components/documents/document-drawer";
import { PhotoEditor } from "@/components/photo/photo-editor";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { getJson, postJson } from "@/lib/api-client";
import { formatBytes } from "@/lib/documents/labels";
import type { DocumentDetail } from "@/lib/documents/service";
import { plural } from "@/lib/format";
import { UPLOAD_ACCEPT, useIntakeUploads } from "@/lib/photos/use-intake-uploads";
import { fetchDocumentDetails, STATUS_CHUNK, usePhotoProcessing } from "@/lib/photos/use-photo-processing";
import type { PhotoView } from "@/lib/photos/views";
import { cn } from "@/lib/utils";

import { Dropzone, type IntakeMode, type IntakeResult } from "./photo-intake";
import { StagedDocumentCard, type StagedDocument, type ThumbSize } from "./staged-documents";

/**
 * The batch mode of `PhotoIntake` (docs/05 §9): each dropped file becomes its own document, then
 * they are staged for grouping, splitting, page reordering and editing before the operator finishes.
 * Everything is saved as it happens, so `Done` only closes.
 */
export function BatchIntake({
  mode,
  onDone,
  onBusyChange,
}: {
  mode: Extract<IntakeMode, { kind: "batch" }>;
  onDone: (result: IntakeResult) => void;
  onBusyChange?: (unfinished: number) => void;
}) {
  const { templates, initialTemplateId, lockTemplate = false } = mode;
  const [templateId, setTemplateId] = useState<string | null>(
    initialTemplateId ?? (templates.length === 1 ? (templates[0]?.id ?? null) : null),
  );
  const [documents, setDocuments] = useState<StagedDocument[]>([]);
  const [photos, setPhotos] = useState<Record<string, PhotoView>>({});
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [size, setSize] = useState<ThumbSize>("medium");
  const [busy, setBusy] = useState(false);
  const [openDocumentId, setOpenDocumentId] = useState<string | null>(null);
  const [editing, setEditing] = useState<PhotoView | null>(null);
  const [deletingPhoto, setDeletingPhoto] = useState<{ photo: PhotoView; page: number } | null>(null);
  const [deletingDocument, setDeletingDocument] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const batchRef = useRef<Promise<string | null> | null>(null);
  const documentsRef = useRef(documents);
  useEffect(() => {
    documentsRef.current = documents;
  }, [documents]);
  // Documents the drawer changed in place (label, page order, edits), refetched on resync.
  const dirtyRef = useRef(new Set<string>());

  const template = templates.find((t) => t.id === templateId) ?? null;

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
    onRegistered: ({ documentId, photo }, file) => {
      setPhotos((prev) => ({ ...prev, [photo.id]: photo }));
      setDocuments((prev) => (prev.some((d) => d.id === documentId) ? prev : [...prev, { id: documentId, label: file.name, photoIds: [photo.id] }]));
    },
  });

  const { unfinished, files } = intake;
  const templateLocked = lockTemplate || files.length > 0;

  useEffect(() => onBusyChange?.(unfinished), [unfinished, onBusyChange]);

  useEffect(() => {
    if (unfinished === 0) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unfinished]);

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
    const details = await fetchDocumentDetails([...refetch]);
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

  // A PDF placeholder disappears when its pages are created, so documents with a missing photo are
  // reloaded in full. Edited pages are polled until their new copy exists.
  usePhotoProcessing(photos, async (views, missing) => {
    setPhotos((prev) => {
      const next = { ...prev, ...Object.fromEntries(views.map((p) => [p.id, p])) };
      for (const id of missing) delete next[id];
      return next;
    });
    const docsToReload = documentsRef.current.filter((d) => d.photoIds.some((id) => missing.includes(id))).map((d) => d.id);
    const details = await fetchDocumentDetails(docsToReload);
    for (const detail of details.values()) if (detail) replaceDocument(detail);
  });

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

        <Dropzone
          inputRef={inputRef}
          onFiles={intake.addFiles}
          accept={UPLOAD_ACCEPT}
          multiple
          disabled={!template}
          compact={documents.length > 0}
          title={template ? "Drop photos or PDFs here, or click to choose files" : "Choose a template first"}
          hint={
            template
              ? `To “${template.name}”. JPEG, PNG, WebP, HEIC or PDF, up to 25 MB each. Each PDF becomes one document.`
              : "Pick the kind of paper you're uploading before choosing files."
          }
        />

        {intake.error ? <FormMessage tone="error">{intake.error}</FormMessage> : null}

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
        <Button onClick={() => onDone({ kind: "batch" })} disabled={unfinished > 0}>
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
