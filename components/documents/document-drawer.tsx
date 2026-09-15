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
import { Crop, GripVertical, Split, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { FormMessage } from "@/components/auth/form-message";
import { PhotoEditor } from "@/components/photo/photo-editor";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { getJson, patchJson, postJson } from "@/lib/api-client";
import { CONTENT_STATE_LABELS, formatBytes, PHOTO_STATUS_LABELS, RUN_STATE_LABELS } from "@/lib/documents/labels";
import type { DocumentDetail } from "@/lib/documents/service";
import { isoDate, plural } from "@/lib/format";
import type { PhotoView } from "@/lib/photos/views";
import { langOf } from "@/lib/templates/labels";
import { cn } from "@/lib/utils";

import { DeleteDocumentsDialog } from "./delete-documents-dialog";
import { DeletePhotoDialog } from "./delete-photo-dialog";

type Props = {
  documentId: string | null;
  onOpenChange: (open: boolean) => void;
  /** The document changed in a way the list shows (label, pages, a new document from a split). */
  onChanged: (id: string) => void;
  onRemoved: (id: string) => void;
};

const POLL_MS = 2000;

/** Processing, or edited and waiting for the new copy. A recorded render error stops the wait. */
function needsPolling(photos: PhotoView[]): boolean {
  return photos.some(
    (p) => (p.status !== "DONE" && p.status !== "FAILED") || (p.status === "DONE" && !p.workingUrl && !p.errorMessage),
  );
}

/** Document detail drawer (docs/05 §9): pages, photo editing, MANUAL values, run history. */
export function DocumentDrawer({ documentId, onOpenChange, onChanged, onRemoved }: Props) {
  const [detail, setDetail] = useState<DocumentDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedPages, setSelectedPages] = useState<Set<string>>(() => new Set());
  const [editing, setEditing] = useState<PhotoView | null>(null);
  const [deletingPhoto, setDeletingPhoto] = useState<{ photo: PhotoView; page: number } | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (id: string) => {
    const result = await getJson<DocumentDetail>(`/api/documents/${id}`);
    if (result.ok) {
      setDetail(result.data);
      setError(null);
    } else {
      setError(result.error.message);
    }
  }, []);

  useEffect(() => {
    setDetail(null);
    setError(null);
    setSelectedPages(new Set());
    if (documentId) void load(documentId);
  }, [documentId, load]);

  const polling = detail ? needsPolling(detail.photos) : false;
  useEffect(() => {
    if (!polling || !documentId) return;
    const t = window.setTimeout(() => void load(documentId), POLL_MS);
    return () => window.clearTimeout(t);
  }, [polling, documentId, detail, load]);

  async function saveLabel(label: string) {
    if (!detail || label.trim() === "" || label === detail.label) return;
    const result = await patchJson<DocumentDetail>(`/api/documents/${detail.id}`, { label });
    if (!result.ok) {
      toast.error(result.error.message);
      return;
    }
    setDetail(result.data);
    onChanged(detail.id);
  }

  async function reorder(photoIds: string[]) {
    if (!detail) return;
    const previous = detail;
    const byId = new Map(detail.photos.map((p) => [p.id, p]));
    setDetail({ ...detail, photos: photoIds.flatMap((id, i) => { const p = byId.get(id); return p ? [{ ...p, pageIndex: i }] : []; }) });
    const result = await postJson<DocumentDetail>(`/api/documents/${detail.id}/reorder-photos`, { photoIds });
    if (!result.ok) {
      setDetail(previous);
      toast.error(result.error.message);
      return;
    }
    setDetail(result.data);
    onChanged(detail.id);
  }

  async function splitSelected() {
    if (!detail) return;
    setBusy(true);
    const photoIds = detail.photos.filter((p) => selectedPages.has(p.id)).map((p) => p.id);
    const result = await postJson<{ documentId: string }>(`/api/documents/${detail.id}/split`, { photoIds });
    setBusy(false);
    if (!result.ok) {
      toast.error(result.error.message);
      return;
    }
    toast.success(`Moved ${plural(photoIds.length, "page")} into a new document.`);
    setSelectedPages(new Set());
    await load(detail.id);
    onChanged(detail.id);
  }

  const lang = langOf(detail?.languageHint ?? null);
  const pageCount = detail?.photos.length ?? 0;
  const canSplit = selectedPages.size > 0 && selectedPages.size < pageCount;

  return (
    <Sheet open={documentId !== null} onOpenChange={onOpenChange}>
      <SheetContent aria-describedby={undefined}>
        {!detail ? (
          <>
            <SheetHeader>
              <SheetTitle>Document</SheetTitle>
            </SheetHeader>
            <div className="p-6">
              {error ? <FormMessage tone="error">{error}</FormMessage> : <p className="text-muted-foreground text-sm">Loading document…</p>}
            </div>
          </>
        ) : (
          <>
            <SheetHeader>
              <SheetTitle className="sr-only">{detail.label ?? "Document"}</SheetTitle>
              <Label htmlFor="document-label" className="text-muted-foreground text-xs">
                Label
              </Label>
              <Input
                id="document-label"
                key={`${detail.id}-${detail.label}`}
                defaultValue={detail.label ?? ""}
                className="text-base font-semibold"
                onBlur={(e) => void saveLabel(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
              />
              <SheetDescription>
                {detail.templateName} · {plural(pageCount, "page")} · {RUN_STATE_LABELS[detail.runState]} ·{" "}
                {CONTENT_STATE_LABELS[detail.contentState]}
              </SheetDescription>
            </SheetHeader>

            <div className="flex flex-1 flex-col gap-6 overflow-y-auto px-6 py-4">
              <section aria-labelledby="pages-heading" className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 id="pages-heading" className="text-sm font-semibold">
                    Pages
                  </h3>
                  <Button size="sm" variant="outline" disabled={!canSplit || busy} onClick={splitSelected}>
                    <Split />
                    Split selected into a new document
                  </Button>
                </div>
                <p className="text-muted-foreground text-xs">
                  Drag pages to put them in paper order. Select pages to move them into their own document.
                </p>
                <PageStrip
                  photos={detail.photos}
                  selected={selectedPages}
                  onSelect={(id, on) =>
                    setSelectedPages((prev) => {
                      const next = new Set(prev);
                      if (on) next.add(id);
                      else next.delete(id);
                      return next;
                    })
                  }
                  onReorder={reorder}
                  onEdit={setEditing}
                  onDelete={(photo, page) => setDeletingPhoto({ photo, page })}
                />
              </section>

              <ManualValues detail={detail} lang={lang} onSaved={setDetail} />

              <section aria-labelledby="runs-heading" className="flex flex-col gap-2">
                <h3 id="runs-heading" className="text-sm font-semibold">
                  Extraction runs
                </h3>
                {detail.runs.length === 0 ? (
                  <p className="text-muted-foreground text-sm">Not extracted yet. Extraction arrives in the next update.</p>
                ) : (
                  <ul className="flex flex-col gap-1 text-sm">
                    {detail.runs.map((r) => (
                      <li key={r.id} className="flex flex-wrap gap-2">
                        <span className="tabular-nums">{isoDate(r.createdAt)}</span>
                        <span>{r.model}</span>
                        <Badge variant={r.state === "FAILED" ? "destructive" : "outline"}>{RUN_STATE_LABELS[r.state]}</Badge>
                        {r.error ? <span className="text-destructive">{r.error}</span> : null}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 border-t px-6 py-3">
              <Button variant="ghost" className="text-destructive" onClick={() => setDeleteOpen(true)}>
                <Trash2 />
                Delete document
              </Button>
              <span title="Extraction arrives in the next update.">
                <Button disabled>Extract</Button>
              </span>
            </div>
          </>
        )}

        {editing ? (
          <PhotoEditor
            photo={editing}
            open
            onOpenChange={(open) => !open && setEditing(null)}
            onSaved={(photo) => {
              setDetail((prev) => (prev ? { ...prev, photos: prev.photos.map((p) => (p.id === photo.id ? photo : p)) } : prev));
              setEditing(null);
              if (documentId) onChanged(documentId);
            }}
          />
        ) : null}
        <DeletePhotoDialog
          target={deletingPhoto}
          onOpenChange={(open) => !open && setDeletingPhoto(null)}
          onDeleted={({ documentDeleted }) => {
            if (!detail) return;
            if (documentDeleted) onRemoved(detail.id);
            else {
              void load(detail.id);
              onChanged(detail.id);
            }
          }}
        />
        {detail ? (
          <DeleteDocumentsDialog open={deleteOpen} onOpenChange={setDeleteOpen} documentIds={[detail.id]} onDeleted={() => onRemoved(detail.id)} />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function PageStrip({
  photos,
  selected,
  onSelect,
  onReorder,
  onEdit,
  onDelete,
}: {
  photos: PhotoView[];
  selected: Set<string>;
  onSelect: (id: string, on: boolean) => void;
  onReorder: (ids: string[]) => void;
  onEdit: (photo: PhotoView) => void;
  onDelete: (photo: PhotoView, page: number) => void;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const ids = photos.map((p) => p.id);

  function onDragEnd(e: DragEndEvent) {
    const from = ids.indexOf(String(e.active.id));
    const to = e.over ? ids.indexOf(String(e.over.id)) : -1;
    if (from < 0 || to < 0 || from === to) return;
    onReorder(arrayMove(ids, from, to));
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={ids} strategy={horizontalListSortingStrategy}>
        <ol className="flex gap-3 overflow-x-auto pb-2" aria-label="Pages in order">
          {photos.map((p, i) => (
            <PageCard
              key={p.id}
              photo={p}
              page={i + 1}
              draggable={photos.length > 1}
              selected={selected.has(p.id)}
              onSelect={(on) => onSelect(p.id, on)}
              onEdit={() => onEdit(p)}
              onDelete={() => onDelete(p, i + 1)}
            />
          ))}
        </ol>
      </SortableContext>
    </DndContext>
  );
}

function PageCard({
  photo,
  page,
  draggable,
  selected,
  onSelect,
  onEdit,
  onDelete,
}: {
  photo: PhotoView;
  page: number;
  draggable: boolean;
  selected: boolean;
  onSelect: (on: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: photo.id, disabled: !draggable });
  const ready = photo.status === "DONE";
  const edited = photo.transform.crop !== null || photo.transform.rotate !== 0 || photo.transform.deskew !== 0;
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn("bg-background flex w-40 shrink-0 flex-col gap-1.5 rounded-lg border p-2", selected && "border-primary ring-primary/30 ring-2", isDragging && "z-10 shadow-lg")}
    >
      <div className="flex items-center gap-1.5">
        <Checkbox checked={selected} onCheckedChange={(c) => onSelect(c === true)} aria-label={`Select page ${page}`} />
        <span className="flex-1 text-xs font-medium">Page {page}</span>
        {draggable ? (
          <button type="button" className="cursor-grab rounded p-0.5" aria-label={`Move page ${page}`} {...attributes} {...listeners}>
            <GripVertical className="size-4" />
          </button>
        ) : null}
      </div>
      <button
        type="button"
        onClick={onEdit}
        disabled={!ready}
        className="bg-muted flex h-44 items-center justify-center overflow-hidden rounded border disabled:cursor-default"
        aria-label={`Edit page ${page}`}
      >
        {photo.thumbUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- presigned storage URL
          <img src={photo.thumbUrl} alt={`Page ${page}`} className="h-full w-full object-contain" />
        ) : (
          <span className={cn("px-2 text-center text-xs", photo.status === "FAILED" ? "text-destructive" : "text-muted-foreground")}>
            {photo.status === "FAILED" ? (photo.errorMessage ?? "Failed") : `${PHOTO_STATUS_LABELS[photo.status]}…`}
          </span>
        )}
      </button>
      <div className="text-muted-foreground flex flex-wrap gap-x-2 text-[11px] tabular-nums">
        <span>{PHOTO_STATUS_LABELS[photo.status]}</span>
        <span>{formatBytes(photo.byteSize)}</span>
        {photo.width > 0 ? (
          <span>
            {photo.width}×{photo.height}
          </span>
        ) : null}
        {edited ? (
          <span className="text-foreground">Edited{ready && !photo.workingUrl && !photo.errorMessage ? " (updating…)" : ""}</span>
        ) : null}
      </div>
      {ready && photo.errorMessage ? <p className="text-destructive text-[11px]">{photo.errorMessage}</p> : null}
      <div className="flex gap-1">
        <Button size="sm" variant="outline" className="h-7 flex-1 px-2 text-xs" onClick={onEdit} disabled={!ready}>
          <Crop />
          Edit
        </Button>
        <Button size="icon" variant="ghost" className="size-7" onClick={onDelete} aria-label={`Delete page ${page}`}>
          <Trash2 />
        </Button>
      </div>
    </li>
  );
}

function ManualValues({ detail, lang, onSaved }: { detail: DocumentDetail; lang: string | undefined; onSaved: (d: DocumentDetail) => void }) {
  const [saving, setSaving] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  async function save(fieldId: string, value: string) {
    const current = detail.manualValues[fieldId] ?? "";
    if (value === current) return;
    setSaving(fieldId);
    const result = await patchJson<DocumentDetail>(`/api/documents/${detail.id}`, {
      manualValues: { [fieldId]: value === "" ? null : value },
    });
    setSaving(null);
    if (!result.ok) {
      setErrors((prev) => ({ ...prev, [fieldId]: result.error.message }));
      return;
    }
    setErrors((prev) => {
      const next = { ...prev };
      delete next[fieldId];
      return next;
    });
    onSaved(result.data);
  }

  return (
    <section aria-labelledby="manual-heading" className="flex flex-col gap-3">
      <h3 id="manual-heading" className="text-sm font-semibold">
        Typed by hand
      </h3>
      {detail.manualFields.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          This template has no Manual fields. Set a field&apos;s mode to Manual in the template to type its value once per
          document here instead of reading it with AI.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {detail.manualFields.map((f) => {
            const inputId = `manual-${f.id}`;
            return (
              <div key={f.id} className="flex flex-col gap-1">
                <Label htmlFor={inputId} className="flex flex-wrap items-baseline gap-2">
                  <span lang={lang} className="font-value">
                    {f.path}
                  </span>
                  {f.labelMeaning ? <span className="text-muted-foreground text-xs font-normal">{f.labelMeaning}</span> : null}
                </Label>
                <Input
                  id={inputId}
                  key={`${f.id}-${detail.manualValues[f.id] ?? ""}`}
                  lang={lang}
                  className="font-value"
                  defaultValue={detail.manualValues[f.id] ?? ""}
                  onBlur={(e) => void save(f.id, e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                  aria-describedby={errors[f.id] ? `${inputId}-error` : undefined}
                />
                {saving === f.id ? <span className="text-muted-foreground text-xs">Saving…</span> : null}
                {errors[f.id] ? (
                  <span id={`${inputId}-error`} className="text-destructive text-xs">
                    {errors[f.id]}
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
