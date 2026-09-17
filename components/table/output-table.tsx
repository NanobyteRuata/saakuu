"use client";

import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
  type Modifier,
} from "@dnd-kit/core";
import { arrayMove, SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { getCoreRowModel, getFilteredRowModel, getSortedRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { RefreshCw } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { FormMessage } from "@/components/auth/form-message";
import { PhotoViewer } from "@/components/photo/photo-viewer";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { getJson, patchJson, postJson } from "@/lib/api-client";
import { formatCount, plural } from "@/lib/format";
import { voidLabel } from "@/lib/table/labels";
import type { CellChangeResult, CellValidationUpdate, TableCell, TableDocument, TableMeta, TableRow } from "@/lib/table/types";
import { compareCells, countCells, isToolbarFiltered, matchesColumnFilter, matchesToolbar, NO_TOOLBAR_FILTER, type ColumnFilter, type ToolbarFilter } from "@/lib/table/view";
import { decodePage, type WirePage } from "@/lib/table/wire";
import { cn } from "@/lib/utils";

import { ColumnHeader, type SortDirection } from "./column-header";
import { columnWidth, GridRow, LEAD_WIDTH, type EditingCell, type RowActions } from "./grid-row";
import { TableLegend } from "./legend";
import { DeleteRowsDialog, RevertRowsDialog, type DeleteRowsResult, type RevertRowsResult } from "./row-dialogs";
import { cellText } from "./table-cell";

const DENSITY = { compact: 28, default: 32, comfortable: 40 } as const;
type Density = keyof typeof DENSITY;
const DENSITY_KEY = "saakuu.table.density";
const HEADER_HEIGHT = 52;
const SAVE_DEBOUNCE_MS = 400;
const UNDO_LIMIT = 100;

type Props = { meta: TableMeta; firstPage: WirePage };

type Focus = { rowId: string; columnId: string };

/** An editing session: debounced saves of one cell, chained so they reach the server in order. */
type Session = {
  rowId: string;
  cellId: string;
  columnId: string;
  original: TableCell;
  serverCell: TableCell;
  editId: string | null;
  lastQueued: string;
  timer: ReturnType<typeof setTimeout> | null;
  chain: Promise<void>;
};

const verticalOnly: Modifier = ({ transform }) => ({ ...transform, x: 0 });

function withCell(rows: TableRow[], rowId: string, cell: TableCell): TableRow[] {
  const i = rows.findIndex((r) => r.id === rowId);
  const row = rows[i];
  if (!row) return rows;
  const next = rows.slice();
  next[i] = { ...row, cells: { ...row.cells, [cell.columnId]: cell } };
  return next;
}

function withValidation(rows: TableRow[], updates: CellValidationUpdate[]): TableRow[] {
  if (updates.length === 0) return rows;
  const byRow = new Map<string, CellValidationUpdate[]>();
  for (const u of updates) byRow.set(u.rowId, [...(byRow.get(u.rowId) ?? []), u]);
  return rows.map((row) => {
    const list = byRow.get(row.id);
    if (!list) return row;
    const cells = { ...row.cells };
    for (const u of list) {
      const entry = Object.entries(cells).find(([, c]) => c.id === u.id);
      if (entry) cells[entry[0]] = { ...entry[1], validationState: u.validationState, validationMsgs: u.validationMsgs };
    }
    return { ...row, cells };
  });
}

function readDensity(): Density {
  try {
    const v = window.localStorage.getItem(DENSITY_KEY);
    return v === "compact" || v === "comfortable" ? v : "default";
  } catch {
    return "default";
  }
}

/**
 * The output table (docs/05 §12, docs/08). All rows are loaded page by page so view-only sorting, filters and
 * counts cover the whole book; rows are virtualised. Manual order is canonical: dragging writes one row, sorting
 * writes nothing. Edits save as you type (debounced), each editing session is one undo step.
 */
export function OutputTable({ meta: initialMeta, firstPage }: Props) {
  const [meta, setMeta] = useState(initialMeta);
  const [rows, setRows] = useState<TableRow[]>(() => decodePage(firstPage).items);
  const [documents, setDocuments] = useState<Map<string, TableDocument>>(() => new Map(firstPage.documents.map((d) => [d.id, d])));
  const [nextCursor, setNextCursor] = useState(firstPage.nextCursor);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [density, setDensity] = useState<Density>("default");
  const [toolbar, setToolbar] = useState<ToolbarFilter>(NO_TOOLBAR_FILTER);
  const [columnFilters, setColumnFilters] = useState<Record<string, ColumnFilter>>({});
  const [sort, setSort] = useState<{ columnId: string; direction: "asc" | "desc" } | null>(null);
  const [focus, setFocus] = useState<Focus | null>(null);
  const [editing, setEditing] = useState<(EditingCell & { rowId: string }) | null>(null);
  const [menu, setMenu] = useState<{ rowId: string; x: number; y: number } | null>(null);
  const [dialog, setDialog] = useState<{ kind: "revert" | "delete"; rowIds: string[] } | null>(null);
  const [viewer, setViewer] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");

  const scrollRef = useRef<HTMLDivElement>(null);
  const session = useRef<Session | null>(null);
  const undoStack = useRef<{ editId: string; rowId: string }[]>([]);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  useEffect(() => setDensity(readDensity()), []);
  const rowHeight = DENSITY[density];

  // ---------- loading ----------

  useEffect(() => {
    if (!nextCursor) return;
    let cancelled = false;
    void getJson<WirePage>(`/api/books/${meta.bookId}/rows?cursor=${encodeURIComponent(nextCursor)}`).then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        setLoadError(result.error.message);
        return;
      }
      const page = decodePage(result.data);
      setRows((prev) => {
        const seen = new Set(prev.map((r) => r.id));
        return [...prev, ...page.items.filter((r) => !seen.has(r.id))];
      });
      setDocuments((prev) => new Map([...prev, ...page.documents.map((d) => [d.id, d] as const)]));
      setNextCursor(page.nextCursor);
    });
    return () => {
      cancelled = true;
    };
  }, [nextCursor, meta.bookId]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setLoadError(null);
    const [m, p] = await Promise.all([getJson<TableMeta>(`/api/books/${meta.bookId}/table-meta`), getJson<WirePage>(`/api/books/${meta.bookId}/rows`)]);
    setRefreshing(false);
    if (!m.ok || !p.ok) {
      setLoadError((!m.ok ? m.error.message : !p.ok ? p.error.message : null) ?? "The table couldn't be loaded.");
      return;
    }
    const page = decodePage(p.data);
    session.current = null;
    undoStack.current = [];
    setEditing(null);
    setMeta(m.data);
    setRows(page.items);
    setDocuments(new Map(page.documents.map((d) => [d.id, d])));
    setNextCursor(page.nextCursor);
    // Sort and filters are the person's view and stay; focus is cleared below if its row is gone.
  }, [meta.bookId]);

  // A focused row that no longer exists (deleted, or gone after a refresh) drops focus once every page is in.
  useEffect(() => {
    if (focus && !nextCursor && !rows.some((r) => r.id === focus.rowId)) setFocus(null);
  }, [focus, nextCursor, rows]);

  // ---------- view model ----------

  const templateNames = useMemo(() => new Map(meta.templates.map((t) => [t.id, t.name])), [meta.templates]);
  const templateOf = useCallback((documentId: string) => documents.get(documentId)?.templateId, [documents]);

  const columnDefs = useMemo<ColumnDef<TableRow>[]>(
    () =>
      meta.columns.map((c) => ({
        id: c.id,
        accessorFn: (row) => row.cells[c.id],
        sortingFn: (a, b) => compareCells(a.original.cells[c.id], b.original.cells[c.id], c.dataType),
        filterFn: (row, id, value: ColumnFilter) => matchesColumnFilter(row.original.cells[id], value),
      })),
    [meta.columns],
  );

  // Stable state objects: a new array each render would make the table recompute (and reset) on every render.
  const sorting = useMemo(() => (sort ? [{ id: sort.columnId, desc: sort.direction === "desc" }] : []), [sort]);
  const tableColumnFilters = useMemo(() => Object.entries(columnFilters).map(([id, value]) => ({ id, value })), [columnFilters]);
  const table = useReactTable({
    data: rows,
    columns: columnDefs,
    state: { sorting, columnFilters: tableColumnFilters, globalFilter: toolbar },
    // Nothing is paged or expanded here; auto-resets would only schedule needless state updates.
    autoResetAll: false,
    manualPagination: true,
    getRowId: (row) => row.id,
    getColumnCanGlobalFilter: () => true,
    globalFilterFn: (row, _columnId, value: ToolbarFilter) => matchesToolbar(row.original, value, templateOf),
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });
  const visible = table.getRowModel().rows;
  const visibleIds = useMemo(() => visible.map((r) => r.id), [visible]);
  const visibleIndex = useMemo(() => new Map(visibleIds.map((id, i) => [id, i])), [visibleIds]);
  const columnIds = useMemo(() => meta.columns.map((c) => c.id), [meta.columns]);
  const counts = useMemo(() => countCells(rows, columnIds), [rows, columnIds]);
  const filtered = isToolbarFiltered(toolbar) || Object.keys(columnFilters).length > 0;
  const totalWidth = LEAD_WIDTH + meta.columns.reduce((n, c) => n + columnWidth(c), 0);

  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    // Generous overscan: fast scrolling outruns rendering less often. Rows are cheap and memoised.
    overscan: 30,
    getItemKey: (i) => visibleIds[i] ?? i,
  });
  useEffect(() => virtualizer.measure(), [rowHeight, virtualizer]);

  // ---------- cell changes ----------

  const applyResult = useCallback((data: CellChangeResult) => {
    setRows((prev) => withValidation(withCell(prev, data.rowId, data.cell), data.affected));
  }, []);

  const findCell = (rowId: string, columnId: string): TableCell | undefined => rowsRef.current.find((r) => r.id === rowId)?.cells[columnId];

  const pushUndo = (editId: string | null, rowId: string) => {
    if (!editId) return;
    undoStack.current.push({ editId, rowId });
    if (undoStack.current.length > UNDO_LIMIT) undoStack.current.shift();
  };

  const enqueueSave = useCallback(
    (s: Session, value: string) => {
      s.lastQueued = value;
      s.chain = s.chain.then(async () => {
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
    [applyResult],
  );

  const startEditing = useCallback((f: Focus, initial?: string) => {
    const cell = findCell(f.rowId, f.columnId);
    if (!cell) return;
    const text = cell.state === "OK" ? (cell.value ?? "") : "";
    session.current = { rowId: f.rowId, cellId: cell.id, columnId: f.columnId, original: cell, serverCell: cell, editId: null, lastQueued: text, timer: null, chain: Promise.resolve() };
    setEditing({ rowId: f.rowId, columnId: f.columnId, initial: initial ?? text });
    if (initial !== undefined && initial !== text) {
      const s = session.current;
      s.timer = setTimeout(() => enqueueSave(s, initial), SAVE_DEBOUNCE_MS);
    }
  }, [enqueueSave]);

  const moveFocus = useCallback(
    (from: Focus, dr: number, dc: number) => {
      const r = Math.max(0, Math.min(visibleIds.length - 1, (visibleIndex.get(from.rowId) ?? 0) + dr));
      const c = Math.max(0, Math.min(columnIds.length - 1, columnIds.indexOf(from.columnId) + dc));
      const rowId = visibleIds[r];
      const columnId = columnIds[c];
      if (!rowId || !columnId) return;
      setFocus({ rowId, columnId });
      virtualizer.scrollToIndex(r, { align: "auto" });
      requestAnimationFrame(() => {
        const cell = rowsRef.current.find((x) => x.id === rowId)?.cells[columnId];
        if (cell) document.getElementById(`cell-${cell.id}`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
      });
    },
    [visibleIds, visibleIndex, columnIds, virtualizer],
  );

  const undo = useCallback(async () => {
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
    setAnnouncement(`Undone. The cell is now ${cellText(result.data.cell) || "empty"}.`);
  }, [applyResult]);

  const actionsRef = useRef<RowActions | null>(null);
  actionsRef.current = {
    draftChanged: (value) => {
      const s = session.current;
      if (!s) return;
      if (s.timer) clearTimeout(s.timer);
      s.timer = setTimeout(() => {
        s.timer = null;
        if (value !== s.lastQueued) enqueueSave(s, value);
      }, SAVE_DEBOUNCE_MS);
    },
    commitEdit: (value, move) => {
      const s = session.current;
      if (!s) return;
      session.current = null;
      if (s.timer) clearTimeout(s.timer);
      setEditing(null);
      if (value !== s.lastQueued) {
        const current = findCell(s.rowId, s.columnId) ?? s.original;
        setRows((prev) => withCell(prev, s.rowId, { ...current, value: value === "" ? null : value, state: value === "" ? "EMPTY" : "OK", isEdited: true }));
        enqueueSave(s, value);
      }
      void s.chain.then(() => pushUndo(s.editId, s.rowId));
      const from = { rowId: s.rowId, columnId: s.columnId };
      if (move === "down") moveFocus(from, 1, 0);
      else if (move === "up") moveFocus(from, -1, 0);
      else if (move === "right") moveFocus(from, 0, 1);
      else if (move === "left") moveFocus(from, 0, -1);
      if (move !== "none") scrollRef.current?.focus({ preventScroll: true });
    },
    cancelEdit: () => {
      const s = session.current;
      if (!s) return;
      session.current = null;
      if (s.timer) clearTimeout(s.timer);
      setEditing(null);
      scrollRef.current?.focus({ preventScroll: true });
      // Saves already made in this session are taken back as one undo.
      void s.chain.then(async () => {
        if (!s.editId) return;
        const result = await postJson<CellChangeResult>(`/api/cell-edits/${s.editId}/undo`, {});
        if (result.ok) applyResult(result.data);
        else toast.error(result.error.message);
      });
    },
    keepMine: (cellId) => {
      void postJson<CellChangeResult>(`/api/cells/${cellId}/keep`, {}).then((result) => {
        if (result.ok) applyResult(result.data);
        else toast.error(result.error.message);
      });
    },
    useExtracted: (rowId, cellId) => {
      void postJson<CellChangeResult>(`/api/cells/${cellId}/revert`, {}).then((result) => {
        if (!result.ok) {
          toast.error(result.error.message);
          return;
        }
        applyResult(result.data);
        pushUndo(result.data.editId, rowId);
        toast.success("Restored the extracted value. Undo with ⌘Z / Ctrl+Z.");
      });
    },
    openMenu: (rowId, x, y) => setMenu({ rowId, x, y }),
    openPhoto: (rowId) => setViewer(rowId),
  };
  const actions = useMemo<RowActions>(
    () => ({
      draftChanged: (v) => actionsRef.current?.draftChanged(v),
      commitEdit: (v, m) => actionsRef.current?.commitEdit(v, m),
      cancelEdit: () => actionsRef.current?.cancelEdit(),
      keepMine: (c) => actionsRef.current?.keepMine(c),
      useExtracted: (r, c) => actionsRef.current?.useExtracted(r, c),
      openMenu: (r, x, y) => actionsRef.current?.openMenu(r, x, y),
      openPhoto: (r) => actionsRef.current?.openPhoto(r),
    }),
    [],
  );

  // ---------- keyboard and pointer ----------

  function onGridKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (editing || e.target !== e.currentTarget) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "z" && !e.shiftKey) {
      e.preventDefault();
      void undo();
      return;
    }
    const firstRow = visibleIds[0];
    const firstColumn = columnIds[0];
    if (!focus) {
      if (firstRow && firstColumn && ["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Enter", "Home"].includes(e.key)) {
        e.preventDefault();
        setFocus({ rowId: firstRow, columnId: firstColumn });
      }
      return;
    }
    const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? 400) / rowHeight) - 1);
    const moves: Record<string, [number, number]> = {
      ArrowDown: [1, 0],
      ArrowUp: [-1, 0],
      ArrowRight: [0, 1],
      ArrowLeft: [0, -1],
      PageDown: [page, 0],
      PageUp: [-page, 0],
      Home: [0, -columnIds.length],
      End: [0, columnIds.length],
    };
    // Tab is left alone so keyboard users can move on past the grid; the editor uses Tab to save and move.
    const move = moves[e.key];
    if (move) {
      e.preventDefault();
      moveFocus(focus, mod && e.key.startsWith("Arrow") ? move[0] * visibleIds.length : move[0], move[1]);
      return;
    }
    if (e.key === "Enter" || e.key === "F2") {
      e.preventDefault();
      startEditing(focus);
      return;
    }
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      const cell = findCell(focus.rowId, focus.columnId);
      if (!cell || (cell.value === null && cell.state === "EMPTY")) return;
      startEditing(focus, "");
      actions.commitEdit("", "none");
      return;
    }
    if (e.key.length === 1 && !mod && !e.altKey) {
      e.preventDefault();
      startEditing(focus, e.key);
    }
  }

  function onGridMouseDown(e: React.MouseEvent<HTMLDivElement>) {
    if (!(e.target instanceof Element) || e.button !== 0) return;
    const cellEl = e.target.closest("[data-column]");
    const rowEl = e.target.closest("[data-row]");
    if (!cellEl || !rowEl || e.target.closest("button")) return;
    const next = { rowId: rowEl.getAttribute("data-row") ?? "", columnId: cellEl.getAttribute("data-column") ?? "" };
    if (!next.rowId || !next.columnId) return;
    e.preventDefault();
    scrollRef.current?.focus({ preventScroll: true });
    // Click a focused cell (or double-click any) to edit it.
    if ((focus?.rowId === next.rowId && focus.columnId === next.columnId) || e.detail >= 2) startEditing(next);
    else setFocus(next);
  }

  // ---------- rows ----------

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));

  function onDragStart(e: DragStartEvent) {
    setDragId(String(e.active.id));
  }

  async function onDragEnd(e: DragEndEvent) {
    setDragId(null);
    const rowId = String(e.active.id);
    const overId = e.over ? String(e.over.id) : null;
    if (!overId || overId === rowId) return;
    const from = visibleIds.indexOf(rowId);
    const to = visibleIds.indexOf(overId);
    if (from < 0 || to < 0) return;
    const order = arrayMove(visibleIds, from, to);
    const prevVisible = order[to - 1];
    const nextVisible = order[to + 1];
    const snapshot = rowsRef.current;
    const without = snapshot.filter((r) => r.id !== rowId);
    // Place after the row now above it; at the top of a filtered view, after whatever precedes the row below.
    let afterRowId: string | null = prevVisible ?? null;
    if (!afterRowId && nextVisible) {
      const i = without.findIndex((r) => r.id === nextVisible);
      afterRowId = i > 0 ? (without[i - 1]?.id ?? null) : null;
    }
    const moved = snapshot.find((r) => r.id === rowId);
    if (!moved) return;
    const insertAt = afterRowId ? without.findIndex((r) => r.id === afterRowId) + 1 : 0;
    setRows([...without.slice(0, insertAt), moved, ...without.slice(insertAt)]);
    const result = await postJson<{ position: string; affected: CellValidationUpdate[] }>("/api/rows/reorder", { rowId, afterRowId });
    if (!result.ok) {
      setRows(snapshot);
      toast.error(result.error.message);
      return;
    }
    setRows((prev) => withValidation(prev.map((r) => (r.id === rowId ? { ...r, position: result.data.position } : r)), result.data.affected));
    setAnnouncement(`Row moved to position ${insertAt + 1}.`);
  }

  async function toggleReviewed(row: TableRow) {
    const cells = Object.values(row.cells);
    const isReviewed = !cells.every((c) => c.isReviewed);
    const snapshot = rowsRef.current;
    setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, cells: Object.fromEntries(Object.entries(r.cells).map(([k, c]) => [k, { ...c, isReviewed }])) } : r)));
    const result = await postJson<{ cells: number }>("/api/cells/review", { rowIds: [row.id], isReviewed });
    if (!result.ok) {
      setRows(snapshot);
      toast.error(result.error.message);
    }
  }

  async function toggleVoid(row: TableRow) {
    const isVoid = !row.isVoid;
    const snapshot = rowsRef.current;
    setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, isVoid } : r)));
    const result = await patchJson<{ isVoid: boolean; affected: CellValidationUpdate[] }>(`/api/rows/${row.id}`, { isVoid });
    if (!result.ok) {
      setRows(snapshot);
      toast.error(result.error.message);
      return;
    }
    setRows((prev) => withValidation(prev, result.data.affected));
    toast.success(isVoid ? "Row marked void. It stays visible but isn't counted or checked." : "Row is no longer void.");
  }

  function onReverted(rowIds: string[], data: RevertRowsResult) {
    const byId = new Map(data.cells.map((c) => [c.id, c]));
    setRows((prev) =>
      withValidation(
        prev.map((r) => (rowIds.includes(r.id) ? { ...r, cells: Object.fromEntries(Object.entries(r.cells).map(([k, c]) => [k, byId.get(c.id) ?? c])) } : r)),
        data.affected,
      ),
    );
    for (const e of data.edits) pushUndo(e.editId, e.rowId);
    toast.success("Reverted to the extracted values. Undo with ⌘Z / Ctrl+Z.");
  }

  function onDeleted(rowIds: string[], data: DeleteRowsResult) {
    setRows((prev) => withValidation(prev.filter((r) => !rowIds.includes(r.id)), data.affected));
    setMeta((m) => ({ ...m, totalRows: m.totalRows - data.deleted }));
    if (focus && rowIds.includes(focus.rowId)) setFocus(null);
    toast.success(`Deleted ${plural(data.deleted, "row")}.`);
  }

  const onSort = useCallback((columnId: string, direction: SortDirection) => {
    setSort(direction ? { columnId, direction } : null);
  }, []);
  const onFilter = useCallback((columnId: string, filter: ColumnFilter | undefined) => {
    setColumnFilters((prev) => {
      const next = { ...prev };
      if (filter) next[columnId] = filter;
      else delete next[columnId];
      return next;
    });
  }, []);

  // ---------- render ----------

  const menuRow = menu ? rows.find((r) => r.id === menu.rowId) : undefined;
  const viewerRow = viewer ? rows.find((r) => r.id === viewer) : undefined;
  const viewerDoc = viewerRow ? documents.get(viewerRow.documentId) : undefined;
  const dragRow = dragId ? rows.find((r) => r.id === dragId) : undefined;
  // Only point assistive tech at a cell that is actually rendered (rows outside the viewport are unmounted).
  const focusIndex = focus ? visibleIndex.get(focus.rowId) : undefined;
  const focusRendered = focusIndex !== undefined && virtualizer.getVirtualItems().some((item) => item.index === focusIndex);
  const activeCell = focus && focusRendered ? rows.find((r) => r.id === focus.rowId)?.cells[focus.columnId] : undefined;
  const loaded = rows.length;

  if (meta.columns.length === 0) {
    return (
      <EmptyState title="This book has no columns yet">
        Add the columns you want to export in{" "}
        <Link className="underline underline-offset-4" href={`/books/${meta.bookId}/settings`}>
          Settings
        </Link>
        , then map template fields to them.
      </EmptyState>
    );
  }
  if (meta.totalRows === 0 && rows.length === 0) {
    return (
      <EmptyState title="No rows yet">
        Rows appear here once a template has read your photos. Upload documents in{" "}
        <Link className="underline underline-offset-4" href={`/books/${meta.bookId}/documents`}>
          Documents
        </Link>{" "}
        and extract them, or check the mappings in{" "}
        <Link className="underline underline-offset-4" href={`/books/${meta.bookId}/templates`}>
          Templates
        </Link>
        .
      </EmptyState>
    );
  }

  return (
    <section aria-label="Output table" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <FilterToggle pressed={toolbar.attention} onClick={() => setToolbar((t) => ({ ...t, attention: !t.attention }))}>
          Needs attention
        </FilterToggle>
        <FilterToggle pressed={toolbar.errors} onClick={() => setToolbar((t) => ({ ...t, errors: !t.errors }))}>
          Has errors
        </FilterToggle>
        <FilterToggle pressed={toolbar.edited} onClick={() => setToolbar((t) => ({ ...t, edited: !t.edited }))}>
          Edited
        </FilterToggle>
        {meta.templates.length > 1 ? (
          <Select value={toolbar.templateId ?? "all"} onValueChange={(v) => setToolbar((t) => ({ ...t, templateId: v === "all" ? null : v }))}>
            <SelectTrigger className="h-8 w-44" aria-label="Template">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All templates</SelectItem>
              {meta.templates.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        <div className="flex items-center gap-1.5 px-1">
          <Checkbox id="show-void" checked={toolbar.showVoid} onCheckedChange={(v) => setToolbar((t) => ({ ...t, showVoid: v === true }))} />
          <Label htmlFor="show-void" className="text-sm font-normal">
            Show void rows
          </Label>
        </div>
        {filtered ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setToolbar(NO_TOOLBAR_FILTER);
              setColumnFilters({});
            }}
          >
            Clear filters
          </Button>
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          <Select
            value={density}
            onValueChange={(v) => {
              const d = v as Density;
              setDensity(d);
              try {
                window.localStorage.setItem(DENSITY_KEY, d);
              } catch {
                // Remembering density is a convenience; the table works without it.
              }
            }}
          >
            <SelectTrigger className="h-8 w-32" aria-label="Row height">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="compact">Compact</SelectItem>
              <SelectItem value="default">Default</SelectItem>
              <SelectItem value="comfortable">Comfortable</SelectItem>
            </SelectContent>
          </Select>
          <TableLegend />
          <Button variant="ghost" size="icon" onClick={() => void refresh()} disabled={refreshing} aria-label="Refresh the table" title="Refresh the table">
            <RefreshCw className={cn("size-4", refreshing && "animate-spin")} />
          </Button>
          <span title="Row review arrives with review mode">
            <Button variant="outline" size="sm" disabled>
              Review rows
            </Button>
          </span>
        </div>
      </div>

      <div className="text-muted-foreground flex flex-wrap items-center justify-between gap-2 text-sm" aria-live="polite">
        <p>
          {formatCount(counts.cells)} cells · {formatCount(counts.unreviewed)} unreviewed · {formatCount(counts.errors)} {counts.errors === 1 ? "error" : "errors"}
          {filtered ? ` · showing ${formatCount(visible.length)} of ${plural(rows.length, "row")}` : ""}
          {sort ? " · sorted for viewing (drag to reorder is off)" : ""}
        </p>
        {nextCursor ? <p>Loading rows… {formatCount(loaded)} of {formatCount(meta.totalRows)}</p> : null}
      </div>
      {loadError ? (
        <div className="flex items-center gap-3">
          <FormMessage tone="error">{loadError}</FormMessage>
          <Button size="sm" variant="outline" onClick={() => void refresh()}>
            Try again
          </Button>
        </div>
      ) : null}

      <div
        ref={scrollRef}
        role="grid"
        aria-label="Output table"
        aria-rowcount={visible.length + 1}
        aria-colcount={meta.columns.length + 1}
        aria-activedescendant={activeCell ? `cell-${activeCell.id}` : undefined}
        tabIndex={0}
        onKeyDown={onGridKeyDown}
        onMouseDown={onGridMouseDown}
        className="focus-visible:ring-ring/50 relative h-[calc(100vh-19rem)] min-h-[24rem] overflow-auto rounded-lg border outline-none focus-visible:ring-[3px]"
      >
        <div style={{ width: totalWidth }}>
          <div role="row" className="bg-muted sticky top-0 z-[5] flex border-b" style={{ height: HEADER_HEIGHT }}>
            <div role="columnheader" className="bg-muted sticky left-0 z-[6] flex shrink-0 items-center border-r px-2 text-xs font-medium" style={{ width: LEAD_WIDTH }}>
              Row · source
            </div>
            {meta.columns.map((c) => (
              <ColumnHeader
                key={c.id}
                column={c}
                width={columnWidth(c)}
                errors={counts.byColumn.get(c.id)?.errors ?? 0}
                unreviewed={counts.byColumn.get(c.id)?.unreviewed ?? 0}
                sort={sort?.columnId === c.id ? sort.direction : false}
                filter={columnFilters[c.id]}
                onSort={onSort}
                onFilter={onFilter}
              />
            ))}
          </div>

          {visible.length === 0 ? (
            <div className="sticky left-0 px-6 py-14 text-center" style={{ width: scrollRef.current?.clientWidth }}>
              <p className="font-medium">No rows match these filters</p>
              <Button
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={() => {
                  setToolbar(NO_TOOLBAR_FILTER);
                  setColumnFilters({});
                }}
              >
                Clear filters
              </Button>
            </div>
          ) : (
            <DndContext sensors={sensors} collisionDetection={closestCenter} modifiers={[verticalOnly]} onDragStart={onDragStart} onDragEnd={(e) => void onDragEnd(e)} onDragCancel={() => setDragId(null)}>
              <SortableContext items={visibleIds} strategy={verticalListSortingStrategy} disabled={sort !== null}>
                {/* Ruled lines under the rows: a frame that scrolls ahead of rendering shows empty rows, not a white gap. */}
                <div
                  className="relative"
                  style={{
                    height: virtualizer.getTotalSize(),
                    backgroundImage: `repeating-linear-gradient(to bottom, transparent 0 ${rowHeight - 1}px, var(--border) ${rowHeight - 1}px ${rowHeight}px)`,
                  }}
                >
                  {virtualizer.getVirtualItems().map((item) => {
                    const row = visible[item.index]?.original;
                    if (!row) return null;
                    const doc = documents.get(row.documentId);
                    return (
                      <GridRow
                        key={row.id}
                        row={row}
                        index={item.index}
                        top={item.start}
                        height={rowHeight}
                        columns={meta.columns}
                        sources={doc ? meta.columnSources[doc.templateId] : undefined}
                        document={doc}
                        templateName={doc ? templateNames.get(doc.templateId) : undefined}
                        threshold={meta.confidenceThreshold}
                        focusedColumnId={focus?.rowId === row.id ? focus.columnId : null}
                        editing={editing?.rowId === row.id ? editing : null}
                        dragDisabled={sort !== null}
                        actions={actions}
                      />
                    );
                  })}
                </div>
              </SortableContext>
              <DragOverlay>
                {dragRow ? (
                  <div className="bg-background flex items-center gap-2 rounded border px-3 text-sm shadow-lg" style={{ height: rowHeight, width: Math.min(totalWidth, 480) }}>
                    <span className="truncate">{documents.get(dragRow.documentId)?.label ?? "Row"}</span>
                    <span className="text-muted-foreground font-value truncate">
                      {meta.columns
                        .slice(0, 3)
                        .map((c) => cellText(dragRow.cells[c.id] ?? { value: null, state: "EMPTY" }))
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </div>
                ) : null}
              </DragOverlay>
            </DndContext>
          )}
        </div>
      </div>
      <p className="text-muted-foreground text-xs">
        Arrow keys move · Enter or typing edits · Tab/Enter saves and moves · Esc cancels · ⌘Z / Ctrl+Z undoes · drag ⋮⋮ to reorder
      </p>
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>

      <DropdownMenu open={menu !== null} onOpenChange={(open) => !open && setMenu(null)}>
        <DropdownMenuTrigger asChild>
          <span aria-hidden className="fixed size-0" style={{ left: menu?.x ?? 0, top: menu?.y ?? 0 }} />
        </DropdownMenuTrigger>
        {menuRow ? (
          <DropdownMenuContent align="start">
            <DropdownMenuItem onSelect={() => void toggleReviewed(menuRow)}>
              {Object.values(menuRow.cells).every((c) => c.isReviewed) ? "Mark row not reviewed" : "Mark row reviewed"}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!Object.values(menuRow.cells).some((c) => c.isEdited || c.disagreement)}
              onSelect={() => setDialog({ kind: "revert", rowIds: [menuRow.id] })}
            >
              Revert row to extracted…
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void toggleVoid(menuRow)}>{menuRow.isVoid ? `Not void (now: ${voidLabel(menuRow.voidReason)})` : "Mark void"}</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setViewer(menuRow.id)}>Open source photo</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-destructive" onSelect={() => setDialog({ kind: "delete", rowIds: [menuRow.id] })}>
              Delete row…
            </DropdownMenuItem>
          </DropdownMenuContent>
        ) : null}
      </DropdownMenu>

      <RevertRowsDialog open={dialog?.kind === "revert"} onOpenChange={(o) => !o && setDialog(null)} rowIds={dialog?.kind === "revert" ? dialog.rowIds : []} onDone={(d) => dialog && onReverted(dialog.rowIds, d)} />
      <DeleteRowsDialog open={dialog?.kind === "delete"} onOpenChange={(o) => !o && setDialog(null)} rowIds={dialog?.kind === "delete" ? dialog.rowIds : []} onDone={(d) => dialog && onDeleted(dialog.rowIds, d)} />
      <PhotoViewer
        open={viewer !== null}
        onOpenChange={(o) => !o && setViewer(null)}
        photoId={viewerRow?.photoId ?? null}
        bbox={viewerRow?.bbox ?? null}
        title={viewerDoc?.label ?? "Source photo"}
        description={`${viewerDoc ? (templateNames.get(viewerDoc.templateId) ?? "") : ""} · row ${viewerRow ? (visibleIndex.get(viewerRow.id) ?? 0) + 1 : ""}`}
      />
    </section>
  );
}

function FilterToggle({ pressed, onClick, children }: { pressed: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <Button variant={pressed ? "secondary" : "outline"} size="sm" aria-pressed={pressed} onClick={onClick} className={cn(pressed && "font-semibold")}>
      {pressed ? "✓ " : ""}
      {children}
    </Button>
  );
}

function EmptyState({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section aria-label="Output table" className="rounded-lg border px-6 py-14 text-center">
      <p className="font-medium">{title}</p>
      <p className="text-muted-foreground mx-auto mt-1 max-w-md text-sm">{children}</p>
    </section>
  );
}
