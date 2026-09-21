"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { FormMessage } from "@/components/auth/form-message";
import { RegionCrop } from "@/components/photo/region-crop";
import { RegionImage, type RegionBox } from "@/components/photo/region-image";
import { Pane, PaneGroup, PaneHandle } from "@/components/shell/pane";
import { attentionTitle, CellValue } from "@/components/table/table-cell";
import { useBookRows } from "@/components/table/use-book-rows";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { getJson } from "@/lib/api-client";
import { formatCount, plural } from "@/lib/format";
import type { PhotoView } from "@/lib/photos/views";
import { progressOf, reviewOrder } from "@/lib/review/progress";
import type { ColumnSource, ColumnSourcesPage, ReviewProgress, ReviewQueuePage } from "@/lib/review/types";
import { resolveCellVisual } from "@/lib/table/cellState";
import type { ColumnSource as FillSource, TableCell, TableColumn, TableMeta, TableRow } from "@/lib/table/types";
import type { WirePage } from "@/lib/table/wire";
import { PHOTO_MIN_PX } from "@/lib/ui/panes";
import { cn } from "@/lib/utils";

import { GlossaryFromReview } from "./glossary-from-review";
import { FieldEditor, type FieldEditorActions } from "./review-field";
import { ReviewPace } from "./review-pace";
import { useCellWrites, type CommitThen } from "./use-cell-writes";

type Props = {
  meta: TableMeta;
  firstPage: WirePage;
  /** Pane sizes are remembered per workspace per user (docs/05 §0). */
  userId: string;
  columnId: string;
  /** Row to open at; otherwise the first row whose cell in this column is unreviewed. */
  startRowId: string | null;
};

type ColumnSourceState = { byRow: Map<string, ColumnSource>; next: string | null; done: boolean; error: string | null };
type PhotoEntry = { view: PhotoView | null; at: number; error?: string };

const LIST_PANE = "sweep";
const PAGE_PANE = "page";
/** The crops need width more than anything else on this screen. */
const LIST_MIN_PX = 480;
const ITEM_ESTIMATE_PX = 104;
const SETTLE_MS = 120;
const PHOTO_TTL_MS = 10 * 60_000;
const PHOTO_BATCH_MAX = 200;
/** A failed photo request is tried again after this, even if the same rows stay on screen. */
const PHOTO_RETRY_MS = 5_000;
const PAGE_STEP = 10;

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function isOpen(row: TableRow, columnId: string): boolean {
  const c = row.cells[columnId];
  return !!c && !c.isReviewed;
}

/**
 * Column sweep (docs/05 §13.1, docs/06 Phase 20): one output column down every document, each value beside the region
 * it was read from on its own page, so the eye stays calibrated on one kind of handwriting. The same cells, keys and
 * writes as row review (`useCellWrites`), so progress and `reviewedVia` are recorded exactly as row review records them.
 */
export function ColumnSweep({ meta: initialMeta, firstPage, userId, columnId: initialColumnId, startRowId }: Props) {
  const router = useRouter();
  const { meta, rows, setRows, rowsRef, documents, nextCursor, loadError, refresh } = useBookRows(initialMeta, firstPage);
  const bookId = meta.bookId;
  const columnIds = useMemo(() => meta.columns.map((c) => c.id), [meta.columns]);
  const templateNames = useMemo(() => new Map(meta.templates.map((t) => [t.id, t.name])), [meta.templates]);

  const [columnId, setColumnId] = useState(initialColumnId);
  const column = meta.columns.find((c) => c.id === columnId);
  const columnIndex = columnIds.indexOf(columnId);

  const order = useMemo(() => reviewOrder(rows), [rows]);
  const orderRef = useRef(order);
  orderRef.current = order;

  const [rowId, setRowId] = useState<string | null>(null);
  const [finished, setFinished] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [serverProgress, setServerProgress] = useState<ReviewProgress | null>(null);
  const [sources, setSources] = useState<Map<string, ColumnSourceState>>(new Map());
  const [photos, setPhotos] = useState<Map<string, PhotoEntry>>(new Map());
  const [zoomHeld, setZoomHeld] = useState(false);
  const [glossaryTerm, setGlossaryTerm] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const requestedPhotos = useRef(new Set<string>());
  const loadingSources = useRef(new Set<string>());
  /** Bumped when region results in flight belong to rows that were reloaded since. */
  const sourcesGeneration = useRef(0);
  /** Bumped when photos must be asked for again: a failure to retry, or presigned links about to expire. */
  const [photoTick, setPhotoTick] = useState(0);

  const focus = useCallback(() => containerRef.current?.focus({ preventScroll: true }), []);
  const onCommittedRef = useRef<(then: CommitThen, at: { rowId: string; cellId: string }) => void>(() => {});
  const { editing, pendingWrites, accept, startEditing, editor, commitOpen, markIllegible, revert, undo: undoLast } = useCellWrites({
    rowsRef,
    setRows,
    announce: setAnnouncement,
    focus,
    onCommitted: (then, at) => onCommittedRef.current(then, at),
  });

  // The column lives in the URL, so a sweep can be linked and reloaded; switching columns doesn't refetch the book.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get("column") === columnId) return;
    url.searchParams.set("column", columnId);
    url.searchParams.delete("row");
    window.history.replaceState(window.history.state, "", url);
  }, [columnId]);

  useEffect(() => {
    let cancelled = false;
    void getJson<ReviewQueuePage>(`/api/books/${bookId}/review-queue?limit=1`).then((result) => {
      if (!cancelled && result.ok) setServerProgress(result.data.progress);
    });
    return () => {
      cancelled = true;
    };
  }, [bookId]);

  // ---------- where to start ----------

  useEffect(() => {
    if (rowId !== null || order.rows.length === 0) return;
    if (startRowId) {
      if (order.indexOf.has(startRowId)) {
        setRowId(startRowId);
        return;
      }
      // Wait for the page holding the row.
      if (nextCursor) return;
    }
    const open = order.rows.find((r) => isOpen(r, columnId));
    if (open) return setRowId(open.id);
    // Nothing open in what's loaded yet; once everything is in, start at the top.
    if (nextCursor) return;
    const first = order.rows[0];
    if (first) {
      setRowId(first.id);
      setFinished(true);
    }
  }, [rowId, startRowId, order, nextCursor, columnId]);

  useEffect(() => {
    containerRef.current?.focus({ preventScroll: true });
  }, [rowId === null]); // eslint-disable-line react-hooks/exhaustive-deps -- focus once the sweep can start

  // A row that disappears (deleted elsewhere, or void after a refresh) moves the sweep to its neighbour.
  const index = rowId !== null ? order.indexOf.get(rowId) : undefined;
  const lastIndex = useRef(0);
  if (index !== undefined) lastIndex.current = index;
  useEffect(() => {
    if (rowId === null || index !== undefined || nextCursor) return;
    const fallback = order.rows[Math.min(lastIndex.current, order.rows.length - 1)];
    setRowId(fallback ? fallback.id : null);
  }, [rowId, index, order, nextCursor]);

  // A column deleted while it was being swept leaves nothing to sweep; row review still works.
  useEffect(() => {
    if (column || meta.columns.length === 0) return;
    const first = meta.columns[0];
    if (first) setColumnId(first.id);
  }, [column, meta.columns]);

  const row = index !== undefined ? order.rows[index] : undefined;
  const cell = row && column ? row.cells[column.id] : undefined;
  const document_ = row ? documents.get(row.documentId) : undefined;

  // ---------- where each value was read ----------

  const columnSources = sources.get(columnId);
  useEffect(() => {
    if (!column || columnSources?.done || columnSources?.error || loadingSources.current.has(columnId)) return;
    const cursor = columnSources?.next ?? null;
    loadingSources.current.add(columnId);
    const forColumn = columnId;
    const generation = sourcesGeneration.current;
    void getJson<ColumnSourcesPage>(`/api/books/${bookId}/column-sources?columnId=${forColumn}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`).then((result) => {
      if (generation !== sourcesGeneration.current) return;
      loadingSources.current.delete(forColumn);
      setSources((prev) => {
        const was = prev.get(forColumn) ?? { byRow: new Map(), next: null, done: false, error: null };
        if (!result.ok) return new Map(prev).set(forColumn, { ...was, error: result.error.message });
        const byRow = new Map(was.byRow);
        for (const item of result.data.items) byRow.set(item.rowId, item);
        return new Map(prev).set(forColumn, { byRow, next: result.data.nextCursor, done: result.data.nextCursor === null, error: null });
      });
    });
  }, [bookId, column, columnId, columnSources]);

  /** Reloads the rows, and with them where each value was read: a rebuild can move or add rows. */
  const reload = async () => {
    if (!(await refresh())) return;
    sourcesGeneration.current++;
    loadingSources.current.clear();
    setSources(new Map());
  };

  const retrySources = () =>
    setSources((prev) => {
      const was = prev.get(columnId);
      return was ? new Map(prev).set(columnId, { ...was, error: null }) : prev;
    });

  // ---------- list ----------

  const virtualizer = useVirtualizer({
    count: order.rows.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => ITEM_ESTIMATE_PX,
    overscan: 6,
    getItemKey: (i) => order.rows[i]?.id ?? i,
  });
  const virtualItems = virtualizer.getVirtualItems();

  useEffect(() => {
    if (index !== undefined) virtualizer.scrollToIndex(index, { align: "auto" });
  }, [index, columnId]); // eslint-disable-line react-hooks/exhaustive-deps -- the virtualizer is stable

  // Photos for what's on screen and the active row, once scrolling settles; presigned links are asked for again later.
  const photoOf = useCallback((r: TableRow | undefined) => (r ? (columnSources?.byRow.get(r.id)?.photoId ?? r.photoId) : null), [columnSources]);
  const wantedPhotos = [...new Set([photoOf(row), ...virtualItems.map((v) => photoOf(order.rows[v.index]))].filter((id): id is string => !!id))].join(",");
  useEffect(() => {
    if (!wantedPhotos) return;
    const t = setTimeout(() => {
      const pending = wantedPhotos.split(",").filter((id) => !requestedPhotos.current.has(id));
      for (let i = 0; i < pending.length; i += PHOTO_BATCH_MAX) {
        const ids = pending.slice(i, i + PHOTO_BATCH_MAX);
        for (const id of ids) requestedPhotos.current.add(id);
        void getJson<PhotoView[]>(`/api/photos/status?ids=${ids.join(",")}`).then((result) => {
          const at = Date.now();
          setPhotos((prev) => {
            const next = new Map(prev);
            if (!result.ok) {
              for (const id of ids) next.set(id, { view: null, at, error: result.error.message });
              return next;
            }
            const views = new Map(result.data.map((v) => [v.id, v]));
            for (const id of ids) {
              const view = views.get(id) ?? null;
              next.set(id, { view, at, ...(view ? {} : { error: "This photo was deleted." }) });
            }
            return next;
          });
          // Forget the request so the effect asks again: soon after a failure, and before a presigned link expires.
          setTimeout(
            () => {
              for (const id of ids) requestedPhotos.current.delete(id);
              setPhotoTick((n) => n + 1);
            },
            result.ok ? PHOTO_TTL_MS : PHOTO_RETRY_MS,
          );
        });
      }
    }, SETTLE_MS);
    return () => clearTimeout(t);
  }, [wantedPhotos, photoTick]);

  // ---------- moving ----------

  const goTo = useCallback((i: number) => {
    const r = orderRef.current.rows[clamp(i, 0, orderRef.current.rows.length - 1)];
    if (!r) return;
    setRowId(r.id);
    containerRef.current?.focus({ preventScroll: true });
  }, []);

  const nextUnreviewed = useCallback(() => {
    const rows_ = orderRef.current.rows;
    const from = rowId !== null ? (orderRef.current.indexOf.get(rowId) ?? -1) : -1;
    for (let step = 1; step <= rows_.length; step++) {
      const r = rows_[(from + step) % rows_.length];
      if (r && isOpen(r, columnId)) {
        setFinished(false);
        setRowId(r.id);
        containerRef.current?.focus({ preventScroll: true });
        return;
      }
    }
    setFinished(true);
  }, [rowId, columnId]);
  const nextUnreviewedRef = useRef(nextUnreviewed);
  nextUnreviewedRef.current = nextUnreviewed;

  /**
   * One value down or up. Past the last value the sweep finishes if nothing in the column is left. `accepted`: the value
   * being left was just marked reviewed, which the rows ref doesn't show until the next render.
   */
  const step = useCallback(
    (from: string, delta: 1 | -1, accepted = false) => {
      const i = orderRef.current.indexOf.get(from);
      if (i === undefined) return;
      const n = orderRef.current.rows.length;
      if (delta === 1 && i === n - 1) {
        if (!rowsRef.current.some((r) => !r.isVoid && !(accepted && r.id === from) && isOpen(r, columnId))) setFinished(true);
        else {
          const message = "That was the last value. Some earlier values in this column are still unreviewed.";
          setAnnouncement(message);
          toast(message, { id: "sweep-end", action: { label: "Next unreviewed", onClick: () => nextUnreviewedRef.current() } });
        }
        return;
      }
      if (delta === -1 && i === 0) return;
      goTo(i + delta);
    },
    [goTo, rowsRef, columnId],
  );

  onCommittedRef.current = (then, at) => {
    // ⌘Enter marks a whole row in row review; here there is only the one value, so it accepts it.
    if (then === "row") accept(at.rowId, at.cellId);
    if (then === "accept" || then === "row") step(at.rowId, 1, true);
    else if (then === "next") step(at.rowId, 1);
    else if (then === "previous") step(at.rowId, -1);
  };

  const switchColumn = useCallback(
    (delta: 1 | -1 | string, { silent = false }: { silent?: boolean } = {}) => {
      const ids = columnIds;
      const nextId = typeof delta === "string" ? delta : ids[ids.indexOf(columnId) + delta];
      const next = nextId ? meta.columns.find((c) => c.id === nextId) : undefined;
      if (!next) {
        if (typeof delta === "string") setAnnouncement("That column doesn't exist any more.");
        else setAnnouncement(delta === 1 ? "This is the last column." : "This is the first column.");
        return;
      }
      commitOpen("stay");
      setColumnId(next.id);
      setFinished(false);
      // Stay on the row: the value beside it in the next column is the one most likely still in mind.
      if (!silent) setAnnouncement(`Sweeping ${next.label}.`);
      containerRef.current?.focus({ preventScroll: true });
    },
    [columnIds, columnId, meta.columns, commitOpen],
  );

  /** The next column, after this one and wrapping, with an unreviewed value. */
  const nextOpenColumn = useMemo(() => {
    for (let s = 1; s < columnIds.length; s++) {
      const id = columnIds[(columnIndex + s) % columnIds.length];
      if (id && order.rows.some((r) => isOpen(r, id))) return meta.columns.find((c) => c.id === id);
    }
    return undefined;
  }, [columnIds, columnIndex, order, meta.columns]);

  const goDocument = (delta: 1 | -1) => {
    if (!row) return;
    const docs = orderRef.current.documents;
    const docId = docs[docs.indexOf(row.documentId) + delta];
    if (docId === undefined) {
      setAnnouncement(delta === 1 ? "This is the last document." : "This is the first document.");
      return;
    }
    const first = orderRef.current.rowsOf.get(docId)?.[0];
    if (first) setRowId(first);
  };

  const undo = async () => {
    const data = await undoLast();
    if (!data) return;
    // Undo already said what it did; moving to the cell it changed shouldn't talk over that.
    if (data.cell.columnId !== columnId) switchColumn(data.cell.columnId, { silent: true });
    if (orderRef.current.indexOf.has(data.rowId)) setRowId(data.rowId);
  };

  /** What was written on the paper for this value (a ditto mark rather than what it resolved to); else the value. */
  function offerGlossary() {
    if (!cell || !row) return;
    const written = columnSources?.byRow.get(row.id)?.written ?? null;
    const value = cell.state === "OK" ? (cell.value ?? "").trim() : "";
    const term = written ?? value;
    if (term === "") {
      setAnnouncement("This cell has no value to add to the glossary.");
      return;
    }
    setGlossaryTerm(term);
  }

  // ---------- keyboard ----------

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (editing !== null || !row || !column) return;
    // Keys pressed in a popover or dialog bubble here through React's tree; they are not sweep keys.
    if (!e.currentTarget.contains(e.target as Node)) return;
    if (e.target instanceof HTMLElement && e.target.closest("[data-sweep-controls]")) return;
    const mod = e.metaKey || e.ctrlKey;
    const i = index ?? 0;
    const key = e.key;
    if (finished && key !== "Escape" && key !== "n" && key !== "N" && key !== "ArrowLeft" && key !== "ArrowRight" && !mod) return;
    const handled = () => e.preventDefault();

    if (key === "Tab" || key === "ArrowDown" || key === "ArrowUp") {
      handled();
      step(row.id, key === "ArrowUp" || (key === "Tab" && e.shiftKey) ? -1 : 1);
    } else if (key === "Enter") {
      handled();
      if (cell) accept(row.id, cell.id);
      step(row.id, 1, !!cell);
    } else if (key === "ArrowLeft" || key === "ArrowRight") {
      handled();
      switchColumn(key === "ArrowRight" ? 1 : -1);
    } else if (mod && key.toLowerCase() === "z" && !e.shiftKey) {
      handled();
      void undo();
    } else if (mod || e.altKey) {
      return;
    } else if (key === "i" || key === "I") {
      handled();
      if (cell) {
        markIllegible(row.id, cell);
        step(row.id, 1, true);
      }
    } else if (key === "r" || key === "R") {
      handled();
      if (cell) revert(row.id, cell);
    } else if (key === "n" || key === "N") {
      handled();
      nextUnreviewed();
    } else if (key === "g" || key === "G") {
      handled();
      offerGlossary();
    } else if (key === "[" || key === "]") {
      handled();
      goDocument(key === "]" ? 1 : -1);
    } else if (key === " ") {
      handled();
      if (!e.repeat) setZoomHeld(true);
    } else if (key === "Escape") {
      handled();
      router.push(`/books/${bookId}`);
    } else if (key === "F2") {
      handled();
      startEditing(row.id, column.id);
    } else if (key === "Delete" || key === "Backspace") {
      handled();
      if (!cell || (cell.value === null && cell.state === "EMPTY")) return;
      startEditing(row.id, column.id, "");
      editor.commit("", "stay");
    } else if (key.length === 1) {
      handled();
      startEditing(row.id, column.id, key);
    } else if (key === "PageDown" || key === "PageUp") {
      handled();
      goTo(i + (key === "PageDown" ? PAGE_STEP : -PAGE_STEP));
    } else if (key === "Home" || key === "End") {
      handled();
      goTo(key === "Home" ? 0 : orderRef.current.rows.length - 1);
    }
  }

  function onKeyUp(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === " ") setZoomHeld(false);
  }

  const onPick = useCallback(
    (pickedRowId: string, edit: boolean) => {
      if (editing !== null) {
        if (editing.cellId === rowsRef.current.find((r) => r.id === pickedRowId)?.cells[columnId]?.id) return;
        commitOpen("stay");
      }
      setRowId(pickedRowId);
      containerRef.current?.focus({ preventScroll: true });
      if (edit) startEditing(pickedRowId, columnId);
    },
    [editing, rowsRef, columnId, commitOpen, startEditing],
  );

  // ---------- render ----------

  const allLoaded = !nextCursor;
  const progress = allLoaded ? progressOf(order, columnIds) : (serverProgress ?? progressOf(order, columnIds));
  const columnProgress = useMemo(() => {
    let cells = 0;
    let reviewed = 0;
    for (const r of order.rows) {
      const c = r.cells[columnId];
      if (!c) continue;
      cells++;
      if (c.isReviewed) reviewed++;
    }
    return { cells, reviewed };
  }, [order, columnId]);
  const percent = columnProgress.cells === 0 ? 100 : Math.floor((columnProgress.reviewed / columnProgress.cells) * 100);

  const activeSource = row ? columnSources?.byRow.get(row.id) : undefined;
  const pagePhotoId = photoOf(row);
  const pageEntry = pagePhotoId ? photos.get(pagePhotoId) : undefined;
  const pageUrl = pageEntry?.view?.workingUrl ?? pageEntry?.view?.thumbUrl ?? null;
  const recordBox = activeSource?.recordBbox ?? row?.bbox ?? null;
  const cellBox = activeSource?.bbox ?? null;
  const boxes: RegionBox[] = [...(recordBox ? [{ bbox: recordBox, tone: "record" as const }] : []), ...(cellBox ? [{ bbox: cellBox, tone: "active" as const }] : [])];
  const focusBox = cellBox ?? recordBox;
  const zoom = zoomHeld && focusBox ? clamp(0.3 / Math.max(focusBox.w, 0.02), 2.5, 6) : recordBox ? clamp(0.95 / Math.max(recordBox.w, 0.05), 1, 3) : 1;

  const header = (
    <div className="flex shrink-0 flex-col gap-1.5 border-b px-4 py-2">
      <div className="flex items-center justify-between gap-2" data-sweep-controls>
        <div className="flex min-w-0 items-center gap-2">
          <Select value={columnId} onValueChange={(id) => switchColumn(id)}>
            <SelectTrigger className="h-8 max-w-64 min-w-0" aria-label="Column to sweep">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {meta.columns.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-muted-foreground truncate text-xs tabular-nums" aria-live="polite">
            {row && index !== undefined ? `Value ${formatCount(index + 1)} of ${formatCount(order.rows.length)}` : "Finding where to start…"}
            {allLoaded ? "" : ` · loading rows ${formatCount(rows.length)} of ${formatCount(meta.totalRows)}`}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <ReviewPace bookId={bookId} />
          <Button variant="outline" size="sm" onClick={nextUnreviewed} onMouseDown={(e) => e.preventDefault()} disabled={!row} title="N">
            Next unreviewed
          </Button>
          <Button variant="ghost" size="sm" asChild>
            <Link href={`/books/${bookId}/review${row ? `?row=${row.id}` : ""}`}>Review rows</Link>
          </Button>
        </div>
      </div>
      <div
        role="progressbar"
        aria-label="Values in this column reviewed"
        aria-valuemin={0}
        aria-valuemax={columnProgress.cells}
        aria-valuenow={columnProgress.reviewed}
        className="bg-muted h-1.5 overflow-hidden rounded-full"
      >
        <div className="h-full bg-(--cell-accent) transition-[width]" style={{ width: `${percent}%` }} />
      </div>
      <div className="text-muted-foreground flex justify-between gap-2 text-xs tabular-nums">
        <p className="truncate">
          {formatCount(columnProgress.reviewed)} of {formatCount(columnProgress.cells)} reviewed in this column · {formatCount(progress.reviewedCells)} of {plural(progress.cells, "cell")} in the book
        </p>
        <p className="shrink-0" aria-live="polite">
          {pendingWrites > 0 ? "saving…" : "all changes saved"}
        </p>
      </div>
    </div>
  );

  if (meta.columns.length === 0 || (meta.totalRows === 0 && rows.length === 0)) {
    return (
      <div className="m-auto max-w-md px-6 py-16 text-center">
        <p className="font-medium">Nothing to review yet</p>
        <p className="text-muted-foreground mt-1 text-sm">
          Rows appear once documents are extracted and their templates are mapped to columns. Start in{" "}
          <Link className="underline underline-offset-4" href={`/books/${bookId}/documents`}>
            Documents
          </Link>
          .
        </p>
      </div>
    );
  }

  const fillSources = meta.columnSources;
  const columnDone = columnProgress.reviewed === columnProgress.cells;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={containerRef}
        tabIndex={0}
        role="application"
        aria-label="Column sweep"
        aria-describedby="sweep-keys"
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onBlur={() => setZoomHeld(false)}
        className="flex min-h-0 flex-1 flex-col outline-none"
      >
        {/*
          Here the crops are the photo: each value's own region, down the column, at the width the list pane is given.
          The page pane is context for a crop that isn't enough, and it keeps the photo pane's readable floor.
        */}
        <PaneGroup workspace="sweep" userId={userId}>
          <Pane id={LIST_PANE} defaultSize="58%" minSize={LIST_MIN_PX}>
            <section aria-label={`Values in ${column?.label ?? "this column"}`} className="flex min-h-0 flex-1 flex-col">
              {header}
              {loadError ? (
                <div className="flex items-center gap-3 border-b px-4 py-2">
                  <FormMessage tone="error">{loadError}</FormMessage>
                  <Button size="sm" variant="outline" onClick={() => void reload()}>
                    Try again
                  </Button>
                </div>
              ) : null}
              {columnSources?.error ? (
                <div className="flex items-center gap-3 border-b px-4 py-2">
                  <FormMessage tone="error">{`Where these values were read couldn't be loaded. ${columnSources.error}`}</FormMessage>
                  <Button size="sm" variant="outline" onClick={retrySources}>
                    Try again
                  </Button>
                </div>
              ) : null}
              {finished ? (
                <div className="m-auto flex max-w-sm flex-col items-center gap-3 px-6 text-center">
                  <p className="font-medium">{columnDone ? `Every value in ${column?.label ?? "this column"} is reviewed` : "You reached the end of this column"}</p>
                  <p className="text-muted-foreground text-sm">
                    {columnDone
                      ? `${plural(columnProgress.cells, "value")} across ${plural(order.documents.length, "document")}.`
                      : `${plural(columnProgress.cells - columnProgress.reviewed, "value")} still unreviewed.`}
                  </p>
                  <div className="flex flex-wrap justify-center gap-2">
                    {!columnDone ? (
                      <Button onClick={nextUnreviewed}>Next unreviewed</Button>
                    ) : nextOpenColumn ? (
                      <Button onClick={() => switchColumn(nextOpenColumn.id)}>Sweep {nextOpenColumn.label}</Button>
                    ) : null}
                    <Button
                      variant="outline"
                      onClick={() => {
                        setFinished(false);
                        goTo(0);
                      }}
                    >
                      Back to the first value
                    </Button>
                  </div>
                </div>
              ) : !row || !column ? (
                <p className="text-muted-foreground m-auto text-sm">Loading rows…</p>
              ) : (
                <div ref={listRef} role="listbox" aria-label={column.label} aria-activedescendant={cell ? `sweep-cell-${cell.id}` : undefined} className="min-h-0 flex-1 overflow-y-auto">
                  <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
                    {virtualItems.map((v) => {
                      const r = order.rows[v.index];
                      if (!r) return null;
                      const doc = documents.get(r.documentId);
                      const prev = order.rows[v.index - 1];
                      const src = columnSources?.byRow.get(r.id);
                      const photoId = src?.photoId ?? r.photoId;
                      const entry = photoId ? photos.get(photoId) : undefined;
                      const c = r.cells[column.id];
                      return (
                        <div key={v.key} data-index={v.index} ref={virtualizer.measureElement} className="absolute inset-x-0 top-0" style={{ transform: `translateY(${v.start}px)` }}>
                          {prev?.documentId !== r.documentId ? (
                            <p className="text-muted-foreground truncate px-4 pt-3 pb-1 text-xs">
                              {doc?.label ?? "Document"}
                              {doc ? ` · ${templateNames.get(doc.templateId) ?? ""}` : ""}
                            </p>
                          ) : null}
                          <SweepItem
                            rowId={r.id}
                            column={column}
                            cell={c}
                            fill={doc ? fillSources[doc.templateId]?.[column.id] : undefined}
                            source={src}
                            sourcesLoaded={!!columnSources?.done || !!src}
                            recordBbox={r.bbox}
                            photoUrl={entry?.view?.workingUrl ?? null}
                            photoError={entry?.error ?? null}
                            active={r.id === row.id}
                            editing={editing !== null && c && editing.cellId === c.id ? editing.initial : null}
                            editor={editor}
                            onPick={onPick}
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
              <p id="sweep-keys" className="text-muted-foreground border-t px-4 py-2 text-xs leading-relaxed">
                Enter accepts and moves down · ↑ ↓ / Tab move · ← → other columns · I unreadable · R revert · G add to glossary · [ ] documents · N next unreviewed · hold Space to
                zoom the page · type or F2 to edit · ⌘Z undo · Esc back to the table
              </p>
            </section>
          </Pane>

          <PaneHandle />

          <Pane id={PAGE_PANE} defaultSize="42%" minSize={PHOTO_MIN_PX} collapsible>
            <section aria-label="Source page" className="flex min-h-0 flex-1 flex-col gap-2 p-3">
              {!row ? (
                <div className="bg-muted h-full animate-pulse rounded-md" />
              ) : !pagePhotoId ? (
                <p className="text-muted-foreground m-auto text-sm">This row has no source photo recorded.</p>
              ) : pageEntry?.error ? (
                <FormMessage tone="error">{pageEntry.error}</FormMessage>
              ) : !pageUrl ? (
                <div className="bg-muted h-full animate-pulse rounded-md" aria-busy="true">
                  <span className="sr-only">Loading photo…</span>
                </div>
              ) : (
                <RegionImage url={pageUrl} alt={`Source page of ${document_?.label ?? "this document"}`} boxes={boxes} zoom={zoom} center={focusBox} className="min-h-0 flex-1" />
              )}
              <p className="text-muted-foreground truncate text-xs">
                {document_?.label ?? "Document"}
                {document_ ? ` · ${templateNames.get(document_.templateId) ?? ""}` : ""}
                {cellBox ? " · the solid box is this value" : recordBox ? " · no region recorded for this value; the dashed box is the row" : ""}
              </p>
            </section>
          </Pane>
        </PaneGroup>
      </div>
      <GlossaryFromReview bookId={bookId} term={glossaryTerm} onClose={() => setGlossaryTerm(null)} />
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
    </div>
  );
}

type ItemProps = {
  rowId: string;
  column: TableColumn;
  cell: TableCell | undefined;
  fill: FillSource | undefined;
  source: ColumnSource | undefined;
  /** False while the column's regions are still loading, so a missing region isn't reported too early. */
  sourcesLoaded: boolean;
  recordBbox: TableRow["bbox"];
  photoUrl: string | null;
  photoError: string | null;
  active: boolean;
  editing: string | null;
  editor: FieldEditorActions;
  onPick: (rowId: string, edit: boolean) => void;
};

/** One value of the column: the region it was read from on its own page, beside the value rendered with the docs/08 channels. */
const SweepItem = memo(function SweepItem({ rowId, column, cell, fill, source, sourcesLoaded, recordBbox, photoUrl, photoError, active, editing, editor, onPick }: ItemProps) {
  if (!cell) {
    return <div className="text-muted-foreground mx-3 my-1 rounded-md border border-dashed px-3 py-2 text-sm">No cell in this column for this row</div>;
  }
  const visual = resolveCellVisual({ ...cell, isManual: fill === "MANUAL", isSkipSourced: fill === "SKIP" });
  const cellBox = source?.bbox ?? null;
  const box = cellBox ?? source?.recordBbox ?? recordBbox;

  return (
    <div
      id={`sweep-cell-${cell.id}`}
      role="option"
      aria-selected={active}
      onMouseDown={(e) => {
        if (editing !== null) return;
        e.preventDefault();
        onPick(rowId, active || e.detail >= 2);
      }}
      className={cn(
        "relative mx-3 my-1 flex gap-3 rounded-md border px-3 py-2",
        active ? "border-(--cell-accent) outline-2 -outline-offset-1 outline-(--cell-accent)" : "hover:border-foreground/30",
      )}
    >
      {visual.attention !== "none" ? <span aria-hidden className={cn("absolute inset-y-0 left-0 w-[3px] rounded-l-md", `cell-bar-${visual.attention}`)} /> : null}
      <div className="flex min-w-0 flex-[3] flex-col justify-center gap-0.5">
        {photoError ? (
          <p className="text-destructive text-xs">{photoError}</p>
        ) : !box ? (
          <p className="text-muted-foreground text-xs">{sourcesLoaded ? "No region recorded for this value." : "Finding where this was read…"}</p>
        ) : !photoUrl ? (
          <div className="bg-muted h-12 animate-pulse rounded" aria-busy="true">
            <span className="sr-only">Loading the region…</span>
          </div>
        ) : (
          <RegionCrop url={photoUrl} bbox={box} alt={`Where ${column.label} was read`} />
        )}
        {box && !cellBox && sourcesLoaded ? <p className="text-muted-foreground text-[11px]">No region for this value; showing the row.</p> : null}
      </div>
      <div className="flex min-w-0 flex-[2] flex-col justify-center gap-1">
        {editing !== null && active ? (
          <FieldEditor initial={editing} label={column.label} editor={editor} />
        ) : (
          <div className={cn("flex min-h-9 items-center rounded px-2 text-base", active && "cursor-text", `cell-authorship-${visual.authorship}`)} title={attentionTitle(cell, visual)}>
            <CellValue cell={cell} visual={visual} numeric={false} />
          </div>
        )}
        <div className="text-muted-foreground flex items-center gap-2 text-xs">
          {cell.confidence !== null && visual.lowConfidence ? <span className="text-(--attn-warn) font-medium tabular-nums">uncertain · {Math.round(cell.confidence * 100)}%</span> : null}
          {cell.isEdited ? <span>edited</span> : null}
          {visual.reviewed ? (
            <span className="flex items-center gap-1 text-(--value-muted)">
              <span aria-hidden className="size-[6px] rounded-full bg-(--reviewed-dot)" />
              reviewed
            </span>
          ) : (
            <span>not reviewed</span>
          )}
        </div>
        {cell.validationMsgs.length > 0 ? (
          <ul className={cn("text-xs", cell.validationState === "ERROR" ? "text-destructive" : "text-(--attn-warn)")}>
            {cell.validationMsgs.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
});
