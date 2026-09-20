"use client";

import { useSortable } from "@dnd-kit/sortable";
import { GripVertical, MoreHorizontal } from "lucide-react";
import { memo, useEffect, useRef, useSyncExternalStore } from "react";

import { voidLabel } from "@/lib/table/labels";
import type { ColumnSource, TableColumn, TableDocument, TableRow } from "@/lib/table/types";
import { cn } from "@/lib/utils";

import { TableCellView, type CellActions } from "./table-cell";
import { thumbs } from "./thumbs";

export const LEAD_WIDTH = 208;

export function columnWidth(column: TableColumn): number {
  switch (column.dataType) {
    case "TEXT":
      return 200;
    case "DATE":
      return 124;
    case "BOOLEAN":
      return 96;
    default:
      return 116;
  }
}

export type RowActions = CellActions & {
  openMenu: (rowId: string, x: number, y: number) => void;
  openPhoto: (rowId: string) => void;
  commitEdit: (value: string, move: "down" | "up" | "right" | "left" | "none") => void;
  cancelEdit: () => void;
  draftChanged: (value: string) => void;
};

export type EditingCell = { columnId: string; initial: string };

type Props = {
  row: TableRow;
  index: number;
  top: number;
  height: number;
  columns: TableColumn[];
  sources: Record<string, ColumnSource> | undefined;
  document: TableDocument | undefined;
  templateName: string | undefined;
  /** The focused cell's column, only when this row holds focus: other rows skip re-rendering on focus moves. */
  focusedColumnId: string | null;
  editing: EditingCell | null;
  dragDisabled: boolean;
  actions: RowActions;
};

function ProvenanceChip({ row, document, templateName, onOpen }: { row: TableRow; document: TableDocument | undefined; templateName: string | undefined; onOpen: () => void }) {
  const url = useSyncExternalStore(thumbs.subscribe, () => thumbs.get(row.photoId), () => null);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
      onMouseDown={(e) => e.stopPropagation()}
      className="bg-background hover:bg-muted hidden h-6 max-w-full min-w-0 items-center gap-1.5 rounded-full border py-0.5 pr-2 pl-0.5 text-xs group-hover/row:flex group-focus-within/row:flex"
      title={`Open the source photo${document?.label ? ` of ${document.label}` : ""}`}
    >
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element -- presigned storage URL
        <img src={url} alt="" className="size-5 shrink-0 rounded-full object-cover" />
      ) : (
        <span className="bg-muted size-5 shrink-0 rounded-full" />
      )}
      <span className="truncate">{templateName ?? "Source photo"}</span>
    </button>
  );
}

export function CellEditor({ width, initial, actions }: { width: number; initial: string; actions: RowActions }) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const finish = (fn: () => void) => {
    if (done.current) return;
    done.current = true;
    fn();
  };
  return (
    <div role="gridcell" className="bg-background relative z-[2] h-full shrink-0 shadow-lg" style={{ width }}>
      <input
        ref={ref}
        defaultValue={initial}
        aria-label="Cell value"
        className="font-value h-full w-full px-2 text-sm tabular-nums outline-2 -outline-offset-2 outline-(--cell-accent)"
        onChange={(e) => actions.draftChanged(e.target.value)}
        onBlur={(e) => {
          // Switching to another window blurs the input too; keep editing; focus comes back with the window.
          if (!document.hasFocus()) return;
          const value = e.target.value;
          finish(() => actions.commitEdit(value, "none"));
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          const value = e.currentTarget.value;
          if (e.key === "Enter") {
            e.preventDefault();
            finish(() => actions.commitEdit(value, e.shiftKey ? "up" : "down"));
          } else if (e.key === "Tab") {
            e.preventDefault();
            finish(() => actions.commitEdit(value, e.shiftKey ? "left" : "right"));
          } else if (e.key === "Escape") {
            e.preventDefault();
            finish(() => actions.cancelEdit());
          }
        }}
      />
    </div>
  );
}

/** One virtualised row: drag handle, row number, document or provenance chip, row menu, then its cells. */
export const GridRow = memo(function GridRow({ row, index, top, height, columns, sources, document, templateName, focusedColumnId, editing, dragDisabled, actions }: Props) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: row.id, disabled: dragDisabled });

  return (
    <div
      ref={setNodeRef}
      role="row"
      aria-rowindex={index + 2}
      data-row={row.id}
      onPointerEnter={() => thumbs.load(row.photoId)}
      onContextMenu={(e) => {
        e.preventDefault();
        actions.openMenu(row.id, e.clientX, e.clientY);
      }}
      className={cn(
        "group/row bg-background absolute left-0 flex border-b hover:bg-[linear-gradient(var(--row-hover),var(--row-hover))]",
        row.isVoid && "text-muted-foreground [&_[role=gridcell]]:opacity-60",
        isDragging && "z-10 opacity-40",
      )}
      // Placed with `top`, not a transform: dnd-kit measures rows without their transform, so a transform-placed row
      // would start its drag preview at the top of the list.
      style={{ height, top, transform: transform ? `translate3d(0, ${transform.y}px, 0)` : undefined, transition: transition ?? undefined }}
    >
      <div role="rowheader" className="bg-background sticky left-0 z-[3] flex h-full shrink-0 items-center gap-1 border-r pr-1" style={{ width: LEAD_WIDTH }}>
        <button
          ref={setActivatorNodeRef}
          type="button"
          {...attributes}
          {...listeners}
          disabled={dragDisabled}
          aria-label={dragDisabled ? "Clear the sort to reorder rows" : `Move row ${index + 1}`}
          title={dragDisabled ? "Clear the sort to reorder rows" : "Drag to reorder (or focus and press Space)"}
          className="text-muted-foreground hover:text-foreground flex h-full w-5 shrink-0 cursor-grab items-center justify-center disabled:cursor-not-allowed disabled:opacity-30"
        >
          <GripVertical className="size-3.5" />
        </button>
        <span className="text-muted-foreground w-9 shrink-0 text-right text-xs tabular-nums">{index + 1}</span>
        <div className="flex min-w-0 flex-1 items-center pl-1">
          <span className="text-muted-foreground truncate text-xs group-hover/row:hidden group-focus-within/row:hidden" title={document?.label ?? undefined}>
            {row.isVoid ? <span className="text-foreground/80 mr-1 font-medium">{voidLabel(row.voidReason)} ·</span> : null}
            {document?.label ?? "Document"}
          </span>
          <ProvenanceChip row={row} document={document} templateName={templateName} onOpen={() => actions.openPhoto(row.id)} />
        </div>
        <button
          type="button"
          aria-label={`Row ${index + 1} actions`}
          title="Row actions"
          className="text-muted-foreground hover:bg-muted hover:text-foreground flex size-6 shrink-0 items-center justify-center rounded"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            actions.openMenu(row.id, rect.left, rect.bottom);
          }}
        >
          <MoreHorizontal className="size-4" />
        </button>
      </div>
      {columns.map((column) =>
        editing?.columnId === column.id ? (
          <CellEditor key={column.id} width={columnWidth(column)} initial={editing.initial} actions={actions} />
        ) : (
          <div key={column.id} data-column={column.id} className="contents">
            <TableCellView
              rowId={row.id}
              cell={row.cells[column.id]}
              source={sources?.[column.id]}
              width={columnWidth(column)}
              focused={focusedColumnId === column.id}
              numeric={column.dataType === "NUMBER" || column.dataType === "INTEGER"}
              actions={actions}
            />
          </div>
        ),
      )}
    </div>
  );
});
