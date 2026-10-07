"use client";

import { Crop, FilePlus2, ImageUp, ListPlus, Plus, Sparkles, Trash2, ZoomIn, ZoomOut } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { FormMessage } from "@/components/auth/form-message";
import { ERROR_RATE_LINE, ReadingResult } from "@/components/documents/reading-result";
import { PhotoEditor } from "@/components/photo/photo-editor";
import { PhotoIntake, PhotoIntakeDialog } from "@/components/photo/photo-intake";
import { RegionImage } from "@/components/photo/region-image";
import { Pane, PaneGroup, PaneHandle } from "@/components/shell/pane";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { getJson } from "@/lib/api-client";
import { READ_STAGE_LABEL, useReadOne } from "@/lib/extraction/use-read-one";
import type { PhotoView } from "@/lib/photos/views";
import type { Bbox } from "@/lib/table/types";
import type { TemplateKind } from "@/lib/templates/schemas";
import type { SpecimenDocument } from "@/lib/templates/specimens";
import { cn } from "@/lib/utils";

import { ProposeFieldsDialog } from "./propose-fields-dialog";
import { ChoosePageDialog, PromoteSpecimenDialog, RemoveSpecimenDialog } from "./specimen-dialogs";

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
 *
 * Decision 78: specimens belong to the template and live only here. A multi-page form is one specimen
 * with several pages; a page already uploaded becomes one by copy; and `Add to documents` adds a copy,
 * so the template keeps its reference page and the test reading never becomes real data by accident.
 */
export function SpecimenPane({
  bookId,
  templateId,
  templateName,
  templateKind,
  userId,
  lang,
  hasExtractFields,
  fieldsChangedAt,
  fieldsKey,
  flushPending,
  onRead,
  onFieldsAdded,
}: {
  bookId: string;
  templateId: string;
  templateName: string;
  templateKind: TemplateKind;
  /** Pane sizes are remembered per workspace per user (docs/05 §0). */
  userId: string;
  lang: string | undefined;
  /** A test reading extracts only fields set to Extract; with none, there is nothing to read. */
  hasExtractFields: boolean;
  /** Bumped by every saved change to what a reading depends on: fields, groups, prompt settings (decision 78). */
  fieldsChangedAt: string;
  /** Changes whenever the fields or groups on screen change, saved or not yet reloaded. */
  fieldsKey: string;
  /** Saves the properties form being edited, so the promote check sees the fields as they are on screen. */
  flushPending: () => Promise<void>;
  /** A reading changes the book's counts and the mapping preview. */
  onRead: () => void;
  /** Accepted proposed fields are in the list now. */
  onFieldsAdded: () => void;
}) {
  const [specimens, setSpecimens] = useState<SpecimenDocument[] | null>(null);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [editing, setEditing] = useState<PhotoView | null>(null);
  const [promoting, setPromoting] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Starting a new specimen (a different form): the same two choices as the empty pane. */
  const [starting, setStarting] = useState(false);
  const [choosingPage, setChoosingPage] = useState(false);
  const [addingPage, setAddingPage] = useState(false);
  const [proposing, setProposing] = useState(false);
  /** The value under the cursor in the reading below, boxed on the page above. */
  const [focusedValue, setFocusedValue] = useState<{ photoId: string | null; bbox: Bbox | null } | null>(null);

  const reading = useReadOne(onRead);
  const zoomOutTo = [...ZOOM_STEPS].reverse().find((s) => s < zoom - 0.001);
  const zoomInTo = ZOOM_STEPS.find((s) => s > zoom + 0.001);

  // The fields as they were when this reading appeared, to notice edits made since.
  const [shown, setShown] = useState<{ raw: unknown; fieldsKey: string }>({ raw: null, fieldsKey });
  if (shown.raw !== reading.raw) setShown({ raw: reading.raw, fieldsKey });
  // The same rule the server applies before copying a test into the documents (`testReadingState`).
  const readAt = reading.detail?.lastExtractedAt ?? null;
  const pagesChanged = reading.detail?.changedSinceLastRead ?? false;
  const readBeforeChanges =
    reading.raw !== null &&
    (shown.fieldsKey !== fieldsKey || pagesChanged || (readAt !== null && Date.parse(readAt) < Date.parse(fieldsChangedAt)));

  const load = useCallback(async (select?: string) => {
    setError(null);
    const result = await getJson<{ documents: SpecimenDocument[] }>(`/api/templates/${templateId}/specimens`);
    if (!result.ok) {
      setError(result.error.message);
      setSpecimens([]);
      return;
    }
    setSpecimens(result.data.documents);
    const has = (id: string | null | undefined) => id != null && result.data.documents.some((d) => d.id === id);
    setCurrentId((prev) => (has(select) ? (select ?? null) : has(prev) ? prev : (result.data.documents[0]?.id ?? null)));
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

  const { resume } = reading;
  useEffect(() => {
    if (currentId) void resume(currentId);
  }, [currentId, resume]);

  /** Saves the form being edited first: the server then judges the test against the fields on screen. */
  async function openPromote() {
    setError(null);
    await flushPending();
    setPromoting(true);
  }

  const busy = reading.stage === "processing" || reading.stage === "extracting";

  if (specimens === null) {
    return (
      <div className="text-muted-foreground flex min-h-0 flex-1 items-center justify-center p-4 text-sm" aria-busy="true">
        Loading the page…
      </div>
    );
  }

  const choosePage = (
    <ChoosePageDialog
      bookId={bookId}
      templateId={templateId}
      lang={lang}
      open={choosingPage}
      onOpenChange={setChoosingPage}
      onChosen={(id) => {
        setStarting(false);
        void load(id);
      }}
    />
  );

  if (specimens.length === 0 || starting) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        <div>
          <h2 className="font-medium">{starting ? "New specimen" : "Put the paper on screen"}</h2>
          <p className="text-muted-foreground text-sm">
            {starting
              ? "A different form of this template, to build against beside the one you have. To add a page to the form on screen, use Add a page instead."
              : `Photograph the page you're building “${templateName}” from, so you can read its labels while you type them.`}{" "}
            A specimen stays with this template: it isn&apos;t in your documents, your table or your export.
          </p>
        </div>
        <PhotoIntake
          mode={{ kind: "specimen", templateId, templateName }}
          onDone={(result) => {
            setStarting(false);
            void load(result.kind === "document" ? result.documentId : undefined);
          }}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={() => setChoosingPage(true)}>
            <FilePlus2 />
            Choose an uploaded page
          </Button>
          {starting ? (
            <Button variant="ghost" onClick={() => setStarting(false)}>
              Cancel
            </Button>
          ) : null}
        </div>
        {error ? <FormMessage tone="error">{error}</FormMessage> : null}
        {choosePage}
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
          <Button size="icon" variant="ghost" className="size-7" aria-label="Zoom out" disabled={zoomOutTo === undefined} onClick={() => zoomOutTo !== undefined && setZoom(zoomOutTo)}>
            <ZoomOut />
          </Button>
          <span className="text-muted-foreground w-9 text-center text-xs tabular-nums" title="Pinch or ⌘-scroll the page to zoom · drag to move">{Math.round(zoom * 100)}%</span>
          <Button
            size="icon"
            variant="ghost"
            className="size-7"
            aria-label="Zoom in"
            disabled={zoomInTo === undefined}
            onClick={() => zoomInTo !== undefined && setZoom(zoomInTo)}
          >
            <ZoomIn />
          </Button>
          <Button size="icon" variant="ghost" className="size-7" aria-label="Crop or straighten this page" disabled={!photo || photo.status !== "DONE"} onClick={() => photo && setEditing(photo)}>
            <Crop />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="size-7"
            aria-label="Add a page to this specimen"
            title="Add a page to this specimen"
            disabled={!current || busy}
            onClick={() => setAddingPage(true)}
          >
            <ImageUp />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="size-7"
            aria-label="New specimen, a different form"
            title="New specimen, a different form"
            onClick={() => setStarting(true)}
          >
            <Plus />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="size-7"
            aria-label="Remove this specimen"
            title="Remove this specimen"
            disabled={!current || busy}
            onClick={() => setRemoving(true)}
          >
            <Trash2 />
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
            onZoomChange={setZoom}
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
        <Button size="sm" variant="outline" disabled={processing || !current} onClick={() => setProposing(true)}>
          <ListPlus />
          Propose fields
        </Button>
        {/* Building on the left; checking the template, then finishing with the page, on the right. */}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <span title={busy ? "Wait for the test to finish." : "Add a copy of this page to your documents. The specimen stays here."}>
            <Button size="sm" variant="ghost" disabled={busy || processing || !current} onClick={() => void openPromote()}>
              Add to documents
            </Button>
          </span>
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
        </div>
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
            <h3 className="text-sm font-medium">
              Test reading <span className="text-muted-foreground font-normal">· stays with this template, not in your table</span>
            </h3>
            {reading.stage === "done" && reading.raw && readBeforeChanges ? (
              <FormMessage tone="info">Read before your latest field changes. Test again to see what your fields read now.</FormMessage>
            ) : null}
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
      {current ? (
        <>
          <PromoteSpecimenDialog
            bookId={bookId}
            specimen={current}
            open={promoting}
            onOpenChange={setPromoting}
            onPromoted={() => onRead()}
          />
          <RemoveSpecimenDialog
            specimen={{ id: current.id, label: current.label, pages: photos.length }}
            templateName={templateName}
            open={removing}
            onOpenChange={setRemoving}
            onRemoved={() => {
              reading.reset();
              void load();
            }}
          />
          <PhotoIntakeDialog
            mode={{
              kind: "page",
              templateId,
              documentId: current.id,
              documentLabel: current.label,
              target: { kind: "add" },
              purpose: "specimen",
            }}
            open={addingPage}
            onOpenChange={setAddingPage}
            description="The page is added after the last one. Test again to read it with the rest."
            onDone={(result) => {
              const id = current.id;
              void load(id).then(() => {
                if (result.kind === "photo") setPageIndex(result.photo.pageIndex);
              });
              // The test now predates a page: refresh it so its note says so.
              void resume(id);
            }}
          />
        </>
      ) : null}
      {choosePage}
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
