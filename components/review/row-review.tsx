"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { FormMessage } from "@/components/auth/form-message";
import { ExportButton, type ExportColumn } from "@/components/export/export-dialog";
import { Pane, PaneGroup, PaneHandle } from "@/components/shell/pane";
import { RegionImage, type RegionBox } from "@/components/photo/region-image";
import { cellText } from "@/components/table/table-cell";
import { useBookRows } from "@/components/table/use-book-rows";
import { Button } from "@/components/ui/button";
import { getJson, patchJson, postJson } from "@/lib/api-client";
import { formatCount, plural } from "@/lib/format";
import type { PhotoView } from "@/lib/photos/views";
import { firstUnreviewedColumn, nextUnreviewedRow, progressOf, reviewOrder } from "@/lib/review/progress";
import type { ReviewProgress, ReviewQueuePage, RowSources } from "@/lib/review/types";
import type { ReviewSource } from "@/lib/table/schemas";
import type { CellChangeResult, TableCell, TableMeta, TableRow } from "@/lib/table/types";
import { withCell, withValidation } from "@/lib/table/view";
import type { WirePage } from "@/lib/table/wire";
import { cn } from "@/lib/utils";

import { ReviewField, type FieldEditorActions } from "./review-field";

type Props = {
  meta: TableMeta;
  firstPage: WirePage;
  /** Pane sizes are remembered per workspace per user (docs/05 §0). */
  userId: string;
  /** Row to open at; otherwise the first row with an unreviewed cell. */
  startRowId: string | null;
  exportSettings: { columns: ExportColumn[]; blankToken: string; illegibleToken: string };
};

type Position = { rowId: string; column: number };

/** An editing session: debounced saves of one cell; the first save's log entry is extended, so it undoes as one step. */
type Session = { rowId: string; cellId: string; serverCell: TableCell; editId: string | null; lastQueued: string; draft: string; timer: ReturnType<typeof setTimeout> | null };

const PHOTO_PANE = "photo";
const CELLS_PANE = "cells";
/** Below this the photo stops being readable, which is the rule every layout yields to (decision 70). */
const PHOTO_MIN_PX = 560;
/** 22rem, the floor the pre-pane grid used for the values column. */
const CELLS_MIN_PX = 352;
const SAVE_DEBOUNCE_MS = 400;
/** Moving faster than this through rows loads no photo or regions for the rows passed over. */
const SETTLE_MS = 120;
const REVIEW_BATCH_MAX = 500;
const UNDO_LIMIT = 100;
const PHOTO_TTL_MS = 10 * 60_000;

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function markReviewed(rows: TableRow[], rowId: string, cellIds: Set<string> | null, isReviewed: boolean): TableRow[] {
  return rows.map((r) =>
    r.id !== rowId ? r : { ...r, cells: Object.fromEntries(Object.entries(r.cells).map(([k, c]) => [k, cellIds === null || cellIds.has(c.id) ? { ...c, isReviewed } : c])) },
  );
}

/**
 * Row review (docs/05 §13): the source photo on the left with the row's region boxed and the active cell's region
 * boxed more strongly; the row's cells as a form on the right. Keyboard first: every action has a key.
 */
export function RowReview({ meta: initialMeta, firstPage, userId, startRowId, exportSettings }: Props) {
  const router = useRouter();
  const { meta, rows, setRows, rowsRef, documents, nextCursor, loadError, refresh } = useBookRows(initialMeta, firstPage);
  const bookId = meta.bookId;
  const columnIds = useMemo(() => meta.columns.map((c) => c.id), [meta.columns]);
  const templateNames = useMemo(() => new Map(meta.templates.map((t) => [t.id, t.name])), [meta.templates]);

  const order = useMemo(() => reviewOrder(rows), [rows]);
  const orderRef = useRef(order);
  orderRef.current = order;

  const [target, setTarget] = useState<string | null | undefined>(startRowId ?? undefined);
  const [pos, setPos] = useState<Position | null>(null);
  const [serverProgress, setServerProgress] = useState<ReviewProgress | null>(null);
  /** The cell being edited and the text its editor opens with. */
  const [editing, setEditing] = useState<{ cellId: string; initial: string } | null>(null);
  const [zoomHeld, setZoomHeld] = useState(false);
  const [fitPage, setFitPage] = useState(false);
  const [finished, setFinished] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [sources, setSources] = useState<Map<string, RowSources>>(new Map());
  const [photos, setPhotos] = useState<Map<string, { view: PhotoView | null; at: number; error?: string }>>(new Map());

  const containerRef = useRef<HTMLDivElement>(null);
  const session = useRef<Session | null>(null);
  const chains = useRef(new Map<string, Promise<void>>());
  const undoStack = useRef<{ editId: string; rowId: string }[]>([]);
  const requested = useRef(new Set<string>());
  const rowMarks = useRef<{ queued: Set<string>; running: boolean }>({ queued: new Set(), running: false });
  const [pendingWrites, setPendingWrites] = useState(0);
  const pendingRef = useRef(0);
  const track = useCallback(<T,>(p: Promise<T>): Promise<T> => {
    pendingRef.current++;
    setPendingWrites(pendingRef.current);
    return p.finally(() => {
      pendingRef.current--;
      setPendingWrites(pendingRef.current);
    });
  }, []);

  // Leaving with saves still on their way would lose them.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (pendingRef.current > 0) e.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  // ---------- where to start ----------

  useEffect(() => {
    let cancelled = false;
    void getJson<ReviewQueuePage>(`/api/books/${bookId}/review-queue?limit=1`).then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        setTarget((t) => (t === undefined ? null : t));
        return;
      }
      setServerProgress(result.data.progress);
      setTarget((t) => (t === undefined ? (result.data.items[0]?.rowId ?? null) : t));
    });
    return () => {
      cancelled = true;
    };
  }, [bookId]);

  useEffect(() => {
    if (pos || target === undefined) return;
    const index = target ? order.indexOf.get(target) : undefined;
    const row = index !== undefined ? order.rows[index] : undefined;
    if (row) {
      setPos({ rowId: row.id, column: firstUnreviewedColumn(row, columnIds) });
      return;
    }
    // Wait for the page holding the row; once everything is in, start at the top.
    if (nextCursor && target) return;
    const first = order.rows[0];
    if (first) {
      setPos({ rowId: first.id, column: firstUnreviewedColumn(first, columnIds) });
      if (target === null) setFinished(nextUnreviewedRow(order, columnIds, -1) === null);
    }
  }, [pos, target, order, nextCursor, columnIds]);

  useEffect(() => {
    containerRef.current?.focus({ preventScroll: true });
  }, [pos === null]); // eslint-disable-line react-hooks/exhaustive-deps -- focus once review can start

  // A row that disappears (deleted elsewhere, or void after a refresh) moves review to its neighbour.
  const index = pos ? order.indexOf.get(pos.rowId) : undefined;
  const lastIndex = useRef(0);
  if (index !== undefined) lastIndex.current = index;
  useEffect(() => {
    if (!pos || index !== undefined || nextCursor) return;
    const fallback = order.rows[Math.min(lastIndex.current, order.rows.length - 1)];
    setPos(fallback ? { rowId: fallback.id, column: 0 } : null);
  }, [pos, index, order, nextCursor]);

  const row = index !== undefined ? order.rows[index] : undefined;
  const column = pos ? meta.columns[clamp(pos.column, 0, meta.columns.length - 1)] : undefined;
  const cell = row && column ? row.cells[column.id] : undefined;
  const document_ = row ? documents.get(row.documentId) : undefined;

  // ---------- sources and photos ----------

  const loadSources = useCallback(
    (rowId: string | undefined) => {
      if (!rowId || requested.current.has(rowId)) return;
      requested.current.add(rowId);
      void getJson<RowSources>(`/api/rows/${rowId}/sources`).then((result) => {
        if (!result.ok) {
          requested.current.delete(rowId);
          return;
        }
        setSources((prev) => new Map(prev).set(rowId, result.data));
      });
    },
    [],
  );

  const loadPhoto = useCallback((photoId: string | null) => {
    if (!photoId) return;
    const key = `photo:${photoId}`;
    if (requested.current.has(key)) return;
    requested.current.add(key);
    void getJson<PhotoView[]>(`/api/photos/status?ids=${photoId}`).then((result) => {
      const at = Date.now();
      if (!result.ok) {
        requested.current.delete(key);
        setPhotos((prev) => new Map(prev).set(photoId, { view: null, at, error: result.error.message }));
        return;
      }
      const view = result.data[0] ?? null;
      setPhotos((prev) => new Map(prev).set(photoId, { view, at, ...(view ? {} : { error: "This photo was deleted." }) }));
      // Presigned links expire; ask again later.
      setTimeout(() => requested.current.delete(key), PHOTO_TTL_MS);
      const url = view?.workingUrl;
      if (url) new Image().src = url;
    });
  }, []);

  const rowSources = row ? sources.get(row.id) : undefined;
  const photoId = rowSources?.photoId ?? row?.photoId ?? null;
  const settledRowId = row?.id;
  useEffect(() => {
    if (settledRowId === undefined) return;
    const t = setTimeout(() => {
      const i = orderRef.current.indexOf.get(settledRowId);
      if (i === undefined) return;
      const here = orderRef.current.rows[i];
      const next = orderRef.current.rows[i + 1];
      loadSources(here?.id);
      loadPhoto(here?.photoId ?? null);
      // Read ahead one row so the end of a row shows the next photo at once.
      loadSources(next?.id);
      loadPhoto(next?.photoId ?? null);
    }, SETTLE_MS);
    return () => clearTimeout(t);
  }, [settledRowId, loadSources, loadPhoto]);
  useEffect(() => {
    const t = setTimeout(() => loadPhoto(photoId), SETTLE_MS);
    return () => clearTimeout(t);
  }, [photoId, loadPhoto]);

  // ---------- writes ----------

  /** Runs writes to one cell in order, so a review mark never races the value it reviews. */
  const onCell = useCallback(
    (cellId: string, fn: () => Promise<void>): Promise<void> => {
      // A failed step is reported where it happens and never blocks the next write to the cell.
      const next = track((chains.current.get(cellId) ?? Promise.resolve()).then(fn).catch(() => {
          toast.error("A change couldn't be saved. Refresh to see what was kept.");
        }),
      );
      chains.current.set(cellId, next);
      return next;
    },
    [track],
  );

  const applyResult = useCallback(
    (data: CellChangeResult) => {
      setRows((prev) => withValidation(withCell(prev, data.rowId, data.cell), data.affected));
    },
    [setRows],
  );

  const pushUndo = (editId: string | null, rowId: string) => {
    if (!editId) return;
    undoStack.current.push({ editId, rowId });
    if (undoStack.current.length > UNDO_LIMIT) undoStack.current.shift();
  };

  const findCell = (rowId: string, cellId: string): TableCell | undefined => Object.values(rowsRef.current.find((r) => r.id === rowId)?.cells ?? {}).find((c) => c.id === cellId);

  const enqueueSave = useCallback(
    (s: Session, value: string) => {
      s.lastQueued = value;
      void onCell(s.cellId, async () => {
        const result = await patchJson<CellChangeResult>(`/api/cells/${s.cellId}`, { value: value === "" ? null : value, ...(s.editId ? { editId: s.editId } : {}) });
        if (result.ok) {
          s.editId = result.data.editId ?? s.editId;
          s.serverCell = result.data.cell;
          applyResult(result.data);
        } else {
          toast.error(result.error.message);
          setRows((prev) => withCell(prev, s.rowId, s.serverCell));
        }
      });
    },
    [onCell, applyResult, setRows],
  );

  /** `via` records how it was confirmed: on its own, or as the tail of marking it unreadable (decision 57). */
  const accept = useCallback(
    (rowId: string, cellId: string, via: ReviewSource = "CELL") => {
      const current = findCell(rowId, cellId);
      if (!current || current.isReviewed) return;
      const ids = new Set([cellId]);
      setRows((prev) => markReviewed(prev, rowId, ids, true));
      void onCell(cellId, async () => {
        const result = await postJson<{ cells: number }>("/api/cells/review", { cellIds: [cellId], isReviewed: true, via });
        // A value save that landed first carried the old mark; put the new one back either way it went.
        setRows((prev) => markReviewed(prev, rowId, ids, result.ok));
        if (!result.ok) toast.error(result.error.message);
      });
    },
    [onCell, setRows], // eslint-disable-line react-hooks/exhaustive-deps -- findCell reads the rows ref
  );

  // ---------- moving ----------

  const goTo = useCallback(
    (rowIndex: number, columnIndex: number) => {
      const target = orderRef.current.rows[clamp(rowIndex, 0, orderRef.current.rows.length - 1)];
      if (!target) return;
      setPos({ rowId: target.id, column: clamp(columnIndex, 0, columnIds.length - 1) });
      containerRef.current?.focus({ preventScroll: true });
    },
    [columnIds.length],
  );

  const nextUnreviewedRef = useRef<() => void>(() => {});
  /** The end of the book with cells still unreviewed before it: say so where it can be seen, with the way back. */
  const notifyUnreviewedBehind = useCallback((message: string) => {
    setAnnouncement(message);
    toast(message, { id: "review-end", action: { label: "Next unreviewed", onClick: () => nextUnreviewedRef.current() } });
  }, []);

  /** One cell forward or back, across row ends. At the very end, review finishes if nothing is left. */
  const step = useCallback(
    (from: Position, delta: 1 | -1) => {
      const i = orderRef.current.indexOf.get(from.rowId);
      if (i === undefined) return;
      const c = from.column + delta;
      if (c >= 0 && c < columnIds.length) return goTo(i, c);
      if (delta === 1 && i === orderRef.current.rows.length - 1) {
        const next = nextUnreviewedRow(orderRef.current, columnIds, i);
        if (next === null) setFinished(true);
        else notifyUnreviewedBehind("That was the last row. Cells before it are still unreviewed.");
        return;
      }
      if (delta === -1 && i === 0) return;
      goTo(i + delta, delta === 1 ? 0 : columnIds.length - 1);
    },
    [goTo, columnIds, notifyUnreviewedBehind],
  );

  const sendRowMarks = useCallback(
    async (queued: Set<string>) => {
      while (queued.size > 0) {
        const ids = [...queued].slice(0, REVIEW_BATCH_MAX);
        for (const id of ids) queued.delete(id);
        const marked = new Set(ids);
        const cellIds = rowsRef.current.filter((r) => marked.has(r.id)).flatMap((r) => Object.values(r.cells).map((c) => c.id));
        // After any value still being saved to those cells.
        await Promise.all(cellIds.map((id) => chains.current.get(id)));
        const result = await postJson<{ cells: number }>("/api/cells/review", { rowIds: ids, isReviewed: true, via: "ROW" });
        setRows((prev) => prev.map((r) => (marked.has(r.id) ? (markReviewed([r], r.id, null, result.ok)[0] ?? r) : r)));
        if (!result.ok) toast.error(result.error.message);
      }
    },
    [rowsRef, setRows],
  );

  /** Sends queued row marks, one request at a time: rows marked in quick succession go together. */
  const flushRowMarks = useCallback(async () => {
    const marks = rowMarks.current;
    if (marks.running) return;
    marks.running = true;
    try {
      await sendRowMarks(marks.queued);
    } finally {
      marks.running = false;
    }
  }, [sendRowMarks]);

  const markRowAndNext = useCallback(
    (rowId: string) => {
      const target = rowsRef.current.find((r) => r.id === rowId);
      if (!target) return;
      setRows((prev) => markReviewed(prev, rowId, null, true));
      rowMarks.current.queued.add(rowId);
      void track(flushRowMarks());
      const i = orderRef.current.indexOf.get(rowId) ?? 0;
      const nextRow = orderRef.current.rows[i + 1];
      if (nextRow) {
        setPos({ rowId: nextRow.id, column: firstUnreviewedColumn(nextRow, columnIds) });
        setAnnouncement(`Row reviewed. Row ${i + 2} of ${orderRef.current.rows.length}.`);
      } else {
        // Local marks are already applied, so this sees the row just marked.
        const rest = nextUnreviewedRow({ ...orderRef.current, rows: orderRef.current.rows.map((r) => (r.id === rowId ? { ...r, cells: Object.fromEntries(Object.entries(r.cells).map(([k, c]) => [k, { ...c, isReviewed: true }])) } : r)) }, columnIds, i);
        if (rest === null) setFinished(true);
        else notifyUnreviewedBehind("That was the last row. Some earlier cells are still unreviewed.");
      }
    },
    [rowsRef, setRows, columnIds, track, flushRowMarks, notifyUnreviewedBehind],
  );

  const goDocument = useCallback(
    (delta: 1 | -1) => {
      if (!pos) return;
      const current = orderRef.current.rows[orderRef.current.indexOf.get(pos.rowId) ?? 0];
      if (!current) return;
      const docs = orderRef.current.documents;
      const d = docs.indexOf(current.documentId) + delta;
      const docId = docs[d];
      if (docId === undefined) {
        setAnnouncement(delta === 1 ? "This is the last document." : "This is the first document.");
        return;
      }
      const firstRowId = orderRef.current.rowsOf.get(docId)?.[0];
      const firstRow = firstRowId ? orderRef.current.rows[orderRef.current.indexOf.get(firstRowId) ?? -1] : undefined;
      if (firstRow) setPos({ rowId: firstRow.id, column: firstUnreviewedColumn(firstRow, columnIds) });
    },
    [pos, columnIds],
  );

  const nextUnreviewed = useCallback(() => {
    const from = pos ? (orderRef.current.indexOf.get(pos.rowId) ?? -1) : -1;
    const next = nextUnreviewedRow(orderRef.current, columnIds, from);
    const nextRow = next === null ? undefined : orderRef.current.rows[next];
    if (!nextRow) {
      setFinished(true);
      return;
    }
    setFinished(false);
    setPos({ rowId: nextRow.id, column: firstUnreviewedColumn(nextRow, columnIds) });
    containerRef.current?.focus({ preventScroll: true });
  }, [pos, columnIds]);
  nextUnreviewedRef.current = nextUnreviewed;

  // ---------- editing ----------

  const startEditing = useCallback(
    (at: Position, initial?: string) => {
      const target = rowsRef.current.find((r) => r.id === at.rowId);
      const columnId = columnIds[at.column];
      const c = target && columnId ? target.cells[columnId] : undefined;
      if (!c) return;
      const text = c.state === "OK" ? (c.value ?? "") : "";
      const s: Session = { rowId: at.rowId, cellId: c.id, serverCell: c, editId: null, lastQueued: text, draft: initial ?? text, timer: null };
      session.current = s;
      setEditing({ cellId: c.id, initial: s.draft });
      if (initial !== undefined && initial !== text) s.timer = setTimeout(() => enqueueSave(s, initial), SAVE_DEBOUNCE_MS);
    },
    [rowsRef, columnIds, enqueueSave],
  );

  const posRef = useRef(pos);
  posRef.current = pos;

  const editor = useMemo<FieldEditorActions>(
    () => ({
      draftChanged: (value) => {
        const s = session.current;
        if (!s) return;
        s.draft = value;
        if (s.timer) clearTimeout(s.timer);
        s.timer = setTimeout(() => {
          s.timer = null;
          if (value !== s.lastQueued) enqueueSave(s, value);
        }, SAVE_DEBOUNCE_MS);
      },
      commit: (value, then) => {
        const s = session.current;
        const at = posRef.current;
        if (!s || !at) return;
        session.current = null;
        if (s.timer) clearTimeout(s.timer);
        setEditing(null);
        if (value !== s.lastQueued) {
          const current = findCell(s.rowId, s.cellId) ?? s.serverCell;
          setRows((prev) => withCell(prev, s.rowId, { ...current, value: value === "" ? null : value, state: value === "" ? "EMPTY" : "OK", isEdited: true }));
          enqueueSave(s, value);
        }
        void (chains.current.get(s.cellId) ?? Promise.resolve()).then(() => pushUndo(s.editId, s.rowId));
        if (then === "accept") {
          accept(s.rowId, s.cellId);
          step(at, 1);
        } else if (then === "next") step(at, 1);
        else if (then === "previous") step(at, -1);
        else if (then === "row") markRowAndNext(s.rowId);
        if (then !== "stay") containerRef.current?.focus({ preventScroll: true });
      },
      cancel: () => {
        const s = session.current;
        if (!s) return;
        session.current = null;
        if (s.timer) clearTimeout(s.timer);
        setEditing(null);
        containerRef.current?.focus({ preventScroll: true });
        // Saves this session already made are taken back as one undo.
        void onCell(s.cellId, async () => {
          if (!s.editId) return;
          const result = await postJson<CellChangeResult>(`/api/cell-edits/${s.editId}/undo`, {});
          if (result.ok) applyResult(result.data);
          else toast.error(result.error.message);
        });
      },
    }),
    [enqueueSave, setRows, accept, step, markRowAndNext, onCell, applyResult], // eslint-disable-line react-hooks/exhaustive-deps -- findCell and pushUndo read refs
  );

  const markIllegible = (rowId: string, c: TableCell) => {
    if (c.state !== "ILLEGIBLE") {
      setRows((prev) => withCell(prev, rowId, { ...c, value: null, state: "ILLEGIBLE", isEdited: true }));
      void onCell(c.id, async () => {
        const result = await patchJson<CellChangeResult>(`/api/cells/${c.id}`, { value: null, state: "ILLEGIBLE" });
        if (!result.ok) {
          toast.error(result.error.message);
          setRows((prev) => withCell(prev, rowId, c));
          return;
        }
        applyResult(result.data);
        pushUndo(result.data.editId, rowId);
      });
    }
    accept(rowId, c.id, "ILLEGIBLE");
    setAnnouncement("Marked unreadable.");
  };

  const revert = (rowId: string, c: TableCell) => {
    if (!c.isEdited && !c.disagreement) {
      setAnnouncement("This cell already holds the extracted value.");
      return;
    }
    void onCell(c.id, async () => {
      const result = await postJson<CellChangeResult>(`/api/cells/${c.id}/revert`, {});
      if (!result.ok) {
        toast.error(result.error.message);
        return;
      }
      applyResult(result.data);
      pushUndo(result.data.editId, rowId);
      setAnnouncement(`Reverted to the extracted value: ${cellText(result.data.cell) || "empty"}.`);
    });
  };

  const undo = async () => {
    const entry = undoStack.current.pop();
    if (!entry) {
      setAnnouncement("Nothing to undo.");
      return;
    }
    const result = await postJson<CellChangeResult>(`/api/cell-edits/${entry.editId}/undo`, {});
    if (!result.ok) {
      toast.error(result.error.message);
      return;
    }
    applyResult(result.data);
    const i = orderRef.current.indexOf.get(result.data.rowId);
    const c = columnIds.indexOf(result.data.cell.columnId);
    if (i !== undefined && c >= 0) goTo(i, c);
    setAnnouncement(`Undone. The cell is now ${cellText(result.data.cell) || "empty"}.`);
  };

  // ---------- keyboard ----------

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (editing !== null || !pos || !row) return;
    const mod = e.metaKey || e.ctrlKey;
    const i = index ?? 0;
    const key = e.key;
    if (finished && key !== "Escape" && key !== "n" && key !== "N" && !mod) return;
    const handled = () => e.preventDefault();

    if (key === "Tab") {
      handled();
      step(pos, e.shiftKey ? -1 : 1);
    } else if (key === "Enter" && mod) {
      handled();
      markRowAndNext(row.id);
    } else if (key === "Enter") {
      handled();
      if (cell) accept(row.id, cell.id);
      step(pos, 1);
    } else if (key === "ArrowDown" || key === "ArrowUp") {
      handled();
      step(pos, key === "ArrowDown" ? 1 : -1);
    } else if (mod && key.toLowerCase() === "z" && !e.shiftKey) {
      handled();
      void undo();
    } else if (mod || e.altKey) {
      return;
    } else if (key === "i" || key === "I") {
      handled();
      if (cell) {
        markIllegible(row.id, cell);
        step(pos, 1);
      }
    } else if (key === "r" || key === "R") {
      handled();
      if (cell) revert(row.id, cell);
    } else if (key === "n" || key === "N") {
      handled();
      nextUnreviewed();
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
      startEditing(pos);
    } else if (key === "Delete" || key === "Backspace") {
      handled();
      if (!cell || (cell.value === null && cell.state === "EMPTY")) return;
      startEditing(pos, "");
      editor.commit("", "stay");
    } else if (key.length === 1) {
      handled();
      startEditing(pos, key);
    } else if (key === "PageDown" || key === "PageUp") {
      handled();
      goTo(i + (key === "PageDown" ? 1 : -1), pos.column);
    }
  }

  function onKeyUp(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === " ") setZoomHeld(false);
  }

  const onPick = useCallback(
    (columnId: string, edit: boolean) => {
      const at = posRef.current;
      if (!at) return;
      const next = { rowId: at.rowId, column: columnIds.indexOf(columnId) };
      if (next.column < 0) return;
      // Picking another cell while editing saves the open edit first; its editor never blurs, as the pick keeps focus.
      const open = session.current;
      if (open) {
        if (open.cellId === rowsRef.current.find((r) => r.id === next.rowId)?.cells[columnId]?.id) return;
        editor.commit(open.draft, "stay");
      }
      setPos(next);
      containerRef.current?.focus({ preventScroll: true });
      if (edit) startEditing(next);
    },
    [columnIds, startEditing, editor, rowsRef],
  );

  // ---------- render ----------

  const allLoaded = !nextCursor;
  const progress = allLoaded ? progressOf(order, columnIds) : (serverProgress ?? progressOf(order, columnIds));
  const docIndex = row ? order.documents.indexOf(row.documentId) : -1;
  const rowsInDoc = row ? (order.rowsOf.get(row.documentId) ?? []) : [];
  const rowInDoc = row ? rowsInDoc.indexOf(row.id) : -1;
  const percent = progress.cells === 0 ? 100 : Math.floor((progress.reviewedCells / progress.cells) * 100);

  const photoEntry = photoId ? photos.get(photoId) : undefined;
  const photoUrl = photoEntry?.view?.workingUrl ?? photoEntry?.view?.thumbUrl ?? null;
  const recordBox = rowSources?.bbox ?? row?.bbox ?? null;
  const cellBox = column ? (rowSources?.cells[column.id]?.bbox ?? null) : null;
  const boxes: RegionBox[] = [...(recordBox ? [{ bbox: recordBox, tone: "record" as const }] : []), ...(cellBox ? [{ bbox: cellBox, tone: "active" as const }] : [])];
  const focusBox = cellBox ?? recordBox;
  const zoom = zoomHeld && focusBox ? clamp(0.3 / Math.max(focusBox.w, 0.02), 2.5, 6) : fitPage || !recordBox ? 1 : clamp(0.95 / Math.max(recordBox.w, 0.05), 1, 3);

  const header = (
    <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-2">
      <div className="flex min-w-0 flex-col">
        <p className="truncate text-sm font-medium">Row review</p>
        <p className="text-muted-foreground text-xs tabular-nums" aria-live="polite">
          {row && docIndex >= 0 ? `Document ${formatCount(docIndex + 1)} of ${formatCount(order.documents.length)} · Row ${formatCount(rowInDoc + 1)} of ${formatCount(rowsInDoc.length)}` : "Finding where to start…"}
          {allLoaded ? "" : ` · loading rows ${formatCount(rows.length)} of ${formatCount(meta.totalRows)}`}
          {pendingWrites > 0 ? " · saving…" : " · all changes saved"}
        </p>
      </div>
      <div className="flex min-w-48 flex-1 flex-col gap-1">
        <div
          role="progressbar"
          aria-label="Cells reviewed"
          aria-valuemin={0}
          aria-valuemax={progress.cells}
          aria-valuenow={progress.reviewedCells}
          className="bg-muted h-1.5 overflow-hidden rounded-full"
        >
          <div className="h-full bg-(--cell-accent) transition-[width]" style={{ width: `${percent}%` }} />
        </div>
        <p className="text-muted-foreground text-xs tabular-nums">
          {formatCount(progress.reviewedCells)} of {plural(progress.cells, "cell")} reviewed · {formatCount(progress.reviewedDocuments)} of {plural(progress.documents, "document")} complete
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={nextUnreviewed} disabled={!pos} title="N">
          Next unreviewed
        </Button>
      </div>
    </div>
  );

  if (meta.columns.length === 0 || (meta.totalRows === 0 && rows.length === 0)) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {header}
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
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {header}
      {loadError ? (
        <div className="flex items-center gap-3 px-4 py-2">
          <FormMessage tone="error">{loadError}</FormMessage>
          <Button size="sm" variant="outline" onClick={() => void refresh()}>
            Try again
          </Button>
        </div>
      ) : null}

      <div
        ref={containerRef}
        tabIndex={0}
        role="application"
        aria-label="Row review"
        aria-describedby="review-keys"
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onBlur={() => setZoomHeld(false)}
        className="flex min-h-0 flex-1 flex-col outline-none"
      >
        {/*
          Two panes, at 1280 and at 1600 alike (docs/05 §0). The photo pane's `minSize` is the rule
          that decides this layout, and it is stated in **pixels** on purpose: handwriting is
          readable or not at a real size, not at a share of whatever screen this is. Everything else
          yields to it. The values pane keeps the 22rem floor the old grid had.
        */}
        <PaneGroup workspace="review" userId={userId}>
          <Pane id={PHOTO_PANE} defaultSize="60%" minSize={PHOTO_MIN_PX}>
            <section aria-label="Source photo" className="flex min-h-0 flex-1 flex-col gap-2 p-3">
              {!row ? (
                <div className="bg-muted h-full animate-pulse rounded-md" />
              ) : !photoId ? (
                <p className="text-muted-foreground m-auto text-sm">This row has no source photo recorded.</p>
              ) : photoEntry?.error ? (
                <FormMessage tone="error">{photoEntry.error}</FormMessage>
              ) : !photoUrl ? (
                <div className="bg-muted h-full animate-pulse rounded-md" aria-busy="true">
                  <span className="sr-only">Loading photo…</span>
                </div>
              ) : (
                <RegionImage url={photoUrl} alt={`Source photo of ${document_?.label ?? "this document"}`} boxes={boxes} zoom={zoom} center={focusBox} className="min-h-0 flex-1" />
              )}
              <div className="text-muted-foreground flex items-center justify-between gap-2 text-xs">
                <span className="truncate">
                  {document_?.label ?? "Document"}
                  {document_ ? ` · ${templateNames.get(document_.templateId) ?? ""}` : ""}
                  {cellBox ? " · the solid box is the active cell" : recordBox ? " · no region recorded for this cell; the dashed box is the row" : ""}
                </span>
                {recordBox ? (
                  <Button variant="ghost" size="sm" onClick={() => setFitPage((f) => !f)} onMouseDown={(e) => e.preventDefault()}>
                    {fitPage ? "Zoom to row" : "Show whole page"}
                  </Button>
                ) : null}
              </div>
            </section>
          </Pane>

          <PaneHandle />

          <Pane id={CELLS_PANE} defaultSize="40%" minSize={CELLS_MIN_PX} collapsible>
            <section aria-label="Row cells" className="flex min-h-0 flex-1 flex-col">
              {finished ? (
                <div className="m-auto flex max-w-sm flex-col items-center gap-3 px-6 text-center">
                  <p className="font-medium">{progress.reviewedCells === progress.cells ? "Every cell is reviewed" : "You reached the end"}</p>
                  <p className="text-muted-foreground text-sm">
                    {progress.reviewedCells === progress.cells
                      ? `${plural(progress.cells, "cell")} across ${plural(progress.documents, "document")}. Export when you're ready.`
                      : `${plural(progress.cells - progress.reviewedCells, "cell")} still unreviewed.`}
                  </p>
                  <div className="flex gap-2">
                    {progress.reviewedCells < progress.cells ? (
                      <Button onClick={nextUnreviewed}>Next unreviewed</Button>
                    ) : (
                      <ExportButton bookId={bookId} columns={exportSettings.columns} blankToken={exportSettings.blankToken} illegibleToken={exportSettings.illegibleToken} rowCount={meta.totalRows} variant="default" />
                    )}
                    <Button
                      variant="outline"
                      onClick={() => {
                        setFinished(false);
                        goTo(0, 0);
                      }}
                    >
                      Back to the first row
                    </Button>
                  </div>
                </div>
              ) : !row ? (
                <p className="text-muted-foreground m-auto text-sm">Loading rows…</p>
              ) : (
                <>
                  <div className="flex items-center justify-between gap-2 border-b px-4 py-2">
                    <p className="truncate text-sm">
                      Row {formatCount((index ?? 0) + 1)} of {formatCount(order.rows.length)}
                    </p>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        // An open edit is saved with the row, as ⌘Enter does while typing.
                        const open = session.current;
                        if (open) editor.commit(open.draft, "row");
                        else markRowAndNext(row.id);
                      }}
                      onMouseDown={(e) => e.preventDefault()}
                    >
                      Mark row reviewed ⌘↵
                    </Button>
                  </div>
                  <div role="listbox" aria-label="Cells" aria-activedescendant={cell ? `review-cell-${cell.id}` : undefined} className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
                    {meta.columns.map((c, ci) => (
                      <ReviewField
                        key={c.id}
                        column={c}
                        cell={row.cells[c.id]}
                        source={document_ ? meta.columnSources[document_.templateId]?.[c.id] : undefined}
                        cellSource={rowSources?.cells[c.id]}
                        threshold={meta.confidenceThreshold}
                        active={pos?.column === ci}
                        editing={editing !== null && editing.cellId === row.cells[c.id]?.id ? editing.initial : null}
                        onPick={onPick}
                        editor={editor}
                      />
                    ))}
                  </div>
                </>
              )}
              <p id="review-keys" className={cn("text-muted-foreground border-t px-4 py-2 text-xs leading-relaxed")}>
                Enter accepts and moves on · Tab / Shift+Tab move · ⌘↵ / Ctrl+Enter marks the row reviewed · I unreadable · R revert · [ ] documents · N next unreviewed · hold Space to zoom
                · type or F2 to edit · ⌘Z undo · Esc back to the table
              </p>
            </section>
          </Pane>
        </PaneGroup>
      </div>
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
    </div>
  );
}
