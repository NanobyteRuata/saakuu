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
import { Crop, GripVertical, PanelRightOpen, Split, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { PHOTO_STATUS_LABELS } from "@/lib/documents/labels";
import { plural } from "@/lib/format";
import type { PhotoView } from "@/lib/photos/views";
import { cn } from "@/lib/utils";

/** A document as the batch intake stages it: what has been created so far, in the order it was picked. */
export type StagedDocument = { id: string; label: string; photoIds: string[] };

export type ThumbSize = "small" | "medium";


export function StagedDocumentCard({
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
  size: ThumbSize;
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
  size: ThumbSize;
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
