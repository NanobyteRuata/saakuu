"use client";

import { Crop, ImageUp, ListPlus, Sparkles, ZoomIn, ZoomOut } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { FormMessage } from "@/components/auth/form-message";
import { ERROR_RATE_LINE, ReadingResult } from "@/components/documents/reading-result";
import { PhotoEditor } from "@/components/photo/photo-editor";
import { PhotoIntake } from "@/components/photo/photo-intake";
import { RegionImage } from "@/components/photo/region-image";
import { Pane, PaneGroup, PaneHandle } from "@/components/shell/pane";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { getJson, patchJson } from "@/lib/api-client";
import { READ_STAGE_LABEL, useReadOne } from "@/lib/extraction/use-read-one";
import type { PhotoView } from "@/lib/photos/views";
import type { Bbox } from "@/lib/table/types";
import type { TemplateKind } from "@/lib/templates/schemas";
import type { SpecimenDocument } from "@/lib/templates/specimens";
import { cn } from "@/lib/utils";

import { ProposeFieldsDialog } from "./propose-fields-dialog";

const ZOOM_STEPS = [1, 1.5, 2, 3, 4];
const PROCESSING_POLL_MS = 2000;

/**
 * The paper, on the screen where the template is authored (Phase 15, docs/05 §7).
 *
 * The operator transcribes twenty Burmese labels off a page on the desk; until now that screen had
 * no image on it, while review — the screen that types the least — did. This is the fix, and it is
 * also where the trust moment moved to: `Test on this page` extracts the specimen with the fields so far
 * and reports what this paper actually produced rather than only the stated rate.
 * Phase 16 adds the other half of that: `Propose fields` reads the same page for its labels, so the
 * twenty labels need not be typed at all.
 */
export function SpecimenPane({
  templateId,
  templateName,
  templateKind,
  userId,
  lang,
  hasExtractFields,
  onRead,
  onFieldsAdded,
}: {
  templateId: string;
  templateName: string;
  templateKind: TemplateKind;
  /** Pane sizes are remembered per workspace per user (docs/05 §0). */
  userId: string;
  lang: string | undefined;
  /** A test reading extracts only fields set to Extract; with none, there is nothing to read. */
  hasExtractFields: boolean;
  /** A reading changes the book's counts and the mapping preview. */
  onRead: () => void;
  /** Accepted proposed fields are in the tree now. */
  onFieldsAdded: () => void;
}) {
  const [specimens, setSpecimens] = useState<SpecimenDocument[] | null>(null);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const [zoomStep, setZoomStep] = useState(0);
  const [editing, setEditing] = useState<PhotoView | null>(null);
  const [promoting, setPromoting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [proposing, setProposing] = useState(false);
  /** The value under the cursor in the reading below, boxed on the page above. */
  const [focusedValue, setFocusedValue] = useState<{ photoId: string | null; bbox: Bbox | null } | null>(null);

  const reading = useReadOne(onRead);
  const zoom = ZOOM_STEPS[zoomStep] ?? 1;

  const load = useCallback(async () => {
    setError(null);
    const result = await getJson<{ documents: SpecimenDocument[] }>(`/api/templates/${templateId}/specimens`);
    if (!result.ok) {
      setError(result.error.message);
      setSpecimens([]);
      return;
    }
    setSpecimens(result.data.documents);
    setCurrentId((prev) => (prev && result.data.documents.some((d) => d.id === prev) ? prev : (result.data.documents[0]?.id ?? null)));
  }, [templateId]);

  useEffect(() => {
    void load();
  }, [load]);

  const current = specimens?.find((d) => d.id === currentId) ?? null;
  const photos = current?.photos ?? [];
  const photo = photos[Math.min(pageIndex, Math.max(photos.length - 1, 0))] ?? null;
  // A freshly uploaded page is still being processed; poll until it has a working copy to show.
  const processing = photo !== null && photo.status !== "FAILED" && photo.workingUrl === null;

  useEffect(() => {
    if (!processing) return;
    const timer = window.setTimeout(() => void load(), PROCESSING_POLL_MS);
    return () => window.clearTimeout(timer);
  }, [processing, load, specimens]);

  useEffect(() => setPageIndex(0), [currentId]);

  async function promote() {
    if (!current) return;
    setError(null);
    setPromoting(true);
    const result = await patchJson(`/api/documents/${current.id}`, { isSpecimen: false });
    setPromoting(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    toast.success(
      `“${current.label ?? "This page"}” is an ordinary document now. Its rows are in the table — it was read like any other page, so nothing is extracted again.`,
    );
    await load();
    onRead();
  }

  const busy = reading.stage === "processing" || reading.stage === "extracting";

  if (specimens === null) {
    return (
      <div className="text-muted-foreground flex min-h-0 flex-1 items-center justify-center p-4 text-sm" aria-busy="true">
        Loading the page…
      </div>
    );
  }

  if (specimens.length === 0 || adding) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        <div>
          <h2 className="font-medium">{adding ? "Add another page" : "Put the paper on screen"}</h2>
          <p className="text-muted-foreground text-sm">
            Photograph the page you&apos;re building “{templateName}” from, so you can read its labels while you type them.
            It stays out of the table, the export and this template&apos;s document count until you say otherwise.
          </p>
        </div>
        <PhotoIntake
          mode={{ kind: "specimen", templateId, templateName }}
          onDone={() => {
            setAdding(false);
            void load();
          }}
        />
        {adding ? (
          <Button variant="outline" className="self-start" onClick={() => setAdding(false)}>
            Cancel
          </Button>
        ) : null}
        {error ? <FormMessage tone="error">{error}</FormMessage> : null}
      </div>
    );
  }

  // A value read from another page of the same document boxes nothing here until that page is shown.
  const box = focusedValue && (focusedValue.photoId === null || focusedValue.photoId === photo?.id) ? focusedValue.bbox : null;

  const image = (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-1.5 border-b px-2 py-1.5">
        {specimens.length > 1 ? (
          <Select value={currentId ?? undefined} onValueChange={setCurrentId}>
            <SelectTrigger className="h-8 max-w-44 text-xs" aria-label="Page on screen">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {specimens.map((d) => (
                <SelectItem key={d.id} value={d.id}>
                  {d.label ?? "Untitled page"}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <p className="min-w-0 flex-1 truncate text-xs font-medium" title={current?.label ?? undefined}>
            {current?.label ?? "Untitled page"}
          </p>
        )}
        {photos.length > 1 ? (
          <div className="flex items-center gap-0.5" role="group" aria-label="Pages">
            {photos.map((p, i) => (
              <button
                key={p.id}
                type="button"
                aria-pressed={i === pageIndex}
                onClick={() => setPageIndex(i)}
                className={cn("rounded px-1.5 py-0.5 text-xs tabular-nums", i === pageIndex ? "bg-muted font-medium" : "text-muted-foreground")}
              >
                p{i + 1}
              </button>
            ))}
          </div>
        ) : null}
        <div className="ml-auto flex items-center gap-0.5">
          <Button size="icon" variant="ghost" className="size-7" aria-label="Zoom out" disabled={zoomStep === 0} onClick={() => setZoomStep((s) => Math.max(s - 1, 0))}>
            <ZoomOut />
          </Button>
          <span className="text-muted-foreground w-9 text-center text-xs tabular-nums">{Math.round(zoom * 100)}%</span>
          <Button
            size="icon"
            variant="ghost"
            className="size-7"
            aria-label="Zoom in"
            disabled={zoomStep >= ZOOM_STEPS.length - 1}
            onClick={() => setZoomStep((s) => Math.min(s + 1, ZOOM_STEPS.length - 1))}
          >
            <ZoomIn />
          </Button>
          <Button size="icon" variant="ghost" className="size-7" aria-label="Crop or straighten this page" disabled={!photo || photo.status !== "DONE"} onClick={() => photo && setEditing(photo)}>
            <Crop />
          </Button>
          <Button size="icon" variant="ghost" className="size-7" aria-label="Add another page" onClick={() => setAdding(true)}>
            <ImageUp />
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 p-2">
        {photo?.workingUrl ? (
          <RegionImage
            url={photo.workingUrl}
            alt={current?.label ?? "The page this template is built from"}
            // Only when the hovered value was read from the page actually on screen.
            boxes={box ? [{ bbox: box, tone: "active" }] : []}
            zoom={zoom}
            center={box}
            className="h-full"
          />
        ) : (
          <div className="text-muted-foreground flex h-full items-center justify-center text-center text-sm" aria-live="polite">
            {photo?.status === "FAILED" ? (photo.errorMessage ?? "That page couldn't be processed.") : "Preparing the page…"}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t px-2 py-1.5">
        {/* A disabled button takes no pointer events, so the tooltip sits on a wrapper. */}
        <span
          title={
            !hasExtractFields
              ? "Add a field set to Extract first. This tests your fields against the page."
              : processing
                ? "Wait for the page to finish processing."
                : busy
                  ? undefined
                  : "Extract this page with your current fields, to check them before reading the whole batch."
          }
        >
          <Button
            size="sm"
            variant="outline"
            disabled={busy || processing || !hasExtractFields}
            onClick={() => current && void reading.read(current.id)}
          >
            <Sparkles />
            {busy ? READ_STAGE_LABEL[reading.stage as "processing" | "extracting"] : reading.raw ? "Test again" : "Test on this page"}
          </Button>
        </span>
        <Button size="sm" variant="outline" disabled={processing || !current} onClick={() => setProposing(true)}>
          <ListPlus />
          Propose fields
        </Button>
        <Button size="sm" variant="ghost" disabled={promoting} onClick={promote}>
          {promoting ? "Using…" : "Use as a real document"}
        </Button>
      </div>
      {reading.error ? (
        <div className="px-2 pb-2">
          <FormMessage tone="error">{reading.error}</FormMessage>
        </div>
      ) : null}
      {error ? (
        <div className="px-2 pb-2">
          <FormMessage tone="error">{error}</FormMessage>
        </div>
      ) : null}
    </div>
  );

  return (
    <>
      {/*
       * The reading sits directly under the page it came from, in its own pane: hovering a value
       * boxes it on the image a few hundred pixels above, which is the whole reason this is not a
       * modal any more.
       */}
      <PaneGroup workspace="template-photo" userId={userId} orientation="vertical">
        <Pane id="page" defaultSize="62%" minSize={200}>
          {image}
        </Pane>
        <PaneHandle orientation="vertical" />
        <Pane id="reading" defaultSize="38%" minSize={120} collapsible>
          <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
            {reading.stage === "done" && reading.raw ? (
              <ReadingResult
                raw={reading.raw}
                detail={reading.detail}
                lang={lang}
                photoClassName={null}
                onFocusValue={setFocusedValue}
                className="min-h-0"
              />
            ) : (
              <p className="text-muted-foreground text-sm">{ERROR_RATE_LINE}</p>
            )}
          </div>
        </Pane>
      </PaneGroup>
      {current ? (
        <ProposeFieldsDialog
          templateId={templateId}
          kind={templateKind}
          documentId={current.id}
          documentLabel={current.label}
          lang={lang}
          open={proposing}
          onOpenChange={setProposing}
          onAdded={onFieldsAdded}
        />
      ) : null}
      {editing ? (
        <PhotoEditor
          photo={editing}
          open
          onOpenChange={(isOpen) => !isOpen && setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      ) : null}
    </>
  );
}
