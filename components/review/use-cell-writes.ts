"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { toast } from "sonner";

import { cellText } from "@/components/table/table-cell";
import { patchJson, postJson } from "@/lib/api-client";
import type { ReviewSource } from "@/lib/table/schemas";
import type { CellChangeResult, TableCell, TableRow } from "@/lib/table/types";
import { withCell, withValidation } from "@/lib/table/view";

import type { FieldEditorActions } from "./review-field";

/** An editing session: debounced saves of one cell; the first save's log entry is extended, so it undoes as one step. */
type Session = { rowId: string; cellId: string; serverCell: TableCell; editId: string | null; lastQueued: string; draft: string; timer: ReturnType<typeof setTimeout> | null };

export type CommitThen = Parameters<FieldEditorActions["commit"]>[1];

type Options = {
  rowsRef: MutableRefObject<TableRow[]>;
  setRows: Dispatch<SetStateAction<TableRow[]>>;
  announce: (message: string) => void;
  /** Returns keyboard focus to the review surface. */
  focus: () => void;
  /**
   * What follows a committed edit, after its value is queued (and, for `accept`, the cell marked reviewed). Moving is the
   * screen's business: row review moves across a row, the column sweep down a column.
   */
  onCommitted: (then: CommitThen, at: { rowId: string; cellId: string }) => void;
};

const SAVE_DEBOUNCE_MS = 400;
const UNDO_LIMIT = 100;

export function markReviewed(rows: TableRow[], rowId: string, cellIds: Set<string> | null, isReviewed: boolean): TableRow[] {
  return rows.map((r) =>
    r.id !== rowId ? r : { ...r, cells: Object.fromEntries(Object.entries(r.cells).map(([k, c]) => [k, cellIds === null || cellIds.has(c.id) ? { ...c, isReviewed } : c])) },
  );
}

/**
 * The writes both review screens make to cells (docs/05 §13, Phase 20): values saved while typing, review marks,
 * unreadable, revert and undo. Writes to one cell run in order, so a review mark never races the value it reviews; a
 * failed step is reported and never blocks the next. Row review and the column sweep record reviews through this one
 * path, which is what makes their progress and `reviewedVia` identical.
 */
export function useCellWrites({ rowsRef, setRows, announce, focus, onCommitted }: Options) {
  const session = useRef<Session | null>(null);
  const chains = useRef(new Map<string, Promise<void>>());
  const undoStack = useRef<{ editId: string; rowId: string }[]>([]);
  /** The cell being edited and the text its editor opens with. */
  const [editing, setEditing] = useState<{ cellId: string; initial: string } | null>(null);
  const [pendingWrites, setPendingWrites] = useState(0);
  const pendingRef = useRef(0);
  const handlers = useRef({ announce, focus, onCommitted });
  handlers.current = { announce, focus, onCommitted };

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

  /** Runs writes to one cell in order. */
  const onCell = useCallback(
    (cellId: string, fn: () => Promise<void>): Promise<void> => {
      const next = track(
        (chains.current.get(cellId) ?? Promise.resolve()).then(fn).catch(() => {
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

  const pushUndo = useCallback((editId: string | null, rowId: string) => {
    if (!editId) return;
    undoStack.current.push({ editId, rowId });
    if (undoStack.current.length > UNDO_LIMIT) undoStack.current.shift();
  }, []);

  const findCell = useCallback((rowId: string, cellId: string): TableCell | undefined => Object.values(rowsRef.current.find((r) => r.id === rowId)?.cells ?? {}).find((c) => c.id === cellId), [rowsRef]);

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
    [findCell, onCell, setRows],
  );

  /** Opens the editor on a cell, optionally replacing its text (typing a character starts an edit with it). */
  const startEditing = useCallback(
    (rowId: string, columnId: string, initial?: string) => {
      const c = rowsRef.current.find((r) => r.id === rowId)?.cells[columnId];
      if (!c) return;
      const text = c.state === "OK" ? (c.value ?? "") : "";
      const s: Session = { rowId, cellId: c.id, serverCell: c, editId: null, lastQueued: text, draft: initial ?? text, timer: null };
      session.current = s;
      setEditing({ cellId: c.id, initial: s.draft });
      if (initial !== undefined && initial !== text) s.timer = setTimeout(() => enqueueSave(s, initial), SAVE_DEBOUNCE_MS);
    },
    [rowsRef, enqueueSave],
  );

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
        if (!s) return;
        session.current = null;
        if (s.timer) clearTimeout(s.timer);
        setEditing(null);
        if (value !== s.lastQueued) {
          const current = findCell(s.rowId, s.cellId) ?? s.serverCell;
          setRows((prev) => withCell(prev, s.rowId, { ...current, value: value === "" ? null : value, state: value === "" ? "EMPTY" : "OK", isEdited: true }));
          enqueueSave(s, value);
        }
        void (chains.current.get(s.cellId) ?? Promise.resolve()).then(() => pushUndo(s.editId, s.rowId));
        if (then === "accept") accept(s.rowId, s.cellId);
        handlers.current.onCommitted(then, { rowId: s.rowId, cellId: s.cellId });
        if (then !== "stay") handlers.current.focus();
      },
      cancel: () => {
        const s = session.current;
        if (!s) return;
        session.current = null;
        if (s.timer) clearTimeout(s.timer);
        setEditing(null);
        handlers.current.focus();
        // Saves this session already made are taken back as one undo.
        void onCell(s.cellId, async () => {
          if (!s.editId) return;
          const result = await postJson<CellChangeResult>(`/api/cell-edits/${s.editId}/undo`, {});
          if (result.ok) applyResult(result.data);
          else toast.error(result.error.message);
        });
      },
    }),
    [enqueueSave, findCell, setRows, pushUndo, accept, onCell, applyResult],
  );

  /** Saves any open edit where it stands, e.g. before picking another cell. */
  const commitOpen = useCallback(
    (then: CommitThen = "stay"): boolean => {
      const open = session.current;
      if (!open) return false;
      editor.commit(open.draft, then);
      return true;
    },
    [editor],
  );

  const markIllegible = useCallback(
    (rowId: string, c: TableCell) => {
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
      handlers.current.announce("Marked unreadable.");
    },
    [setRows, onCell, applyResult, pushUndo, accept],
  );

  const revert = useCallback(
    (rowId: string, c: TableCell) => {
      if (!c.isEdited && !c.disagreement) {
        handlers.current.announce("This cell already holds the extracted value.");
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
        handlers.current.announce(`Reverted to the extracted value: ${cellText(result.data.cell) || "empty"}.`);
      });
    },
    [onCell, applyResult, pushUndo],
  );

  /** Takes back the last edit. Resolves to the cell it changed, so the screen can move there. */
  const undo = useCallback(async (): Promise<CellChangeResult | null> => {
    const entry = undoStack.current.pop();
    if (!entry) {
      handlers.current.announce("Nothing to undo.");
      return null;
    }
    const result = await postJson<CellChangeResult>(`/api/cell-edits/${entry.editId}/undo`, {});
    if (!result.ok) {
      toast.error(result.error.message);
      return null;
    }
    applyResult(result.data);
    handlers.current.announce(`Undone. The cell is now ${cellText(result.data.cell) || "empty"}.`);
    return result.data;
  }, [applyResult]);

  return { editing, pendingWrites, track, chains, onCell, accept, startEditing, editor, commitOpen, session, markIllegible, revert, undo };
}
