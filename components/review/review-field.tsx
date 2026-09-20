"use client";

import { memo, useEffect, useRef } from "react";

import { attentionTitle, cellText, CellValue, valueLang } from "@/components/table/table-cell";
import type { CellSource } from "@/lib/review/sources";
import { resolveCellVisual } from "@/lib/table/cellState";
import type { ColumnSource, TableCell, TableColumn } from "@/lib/table/types";
import { cn } from "@/lib/utils";

export type FieldEditorActions = {
  draftChanged: (value: string) => void;
  /** `then`: what follows saving. */
  commit: (value: string, then: "accept" | "next" | "previous" | "row" | "stay") => void;
  cancel: () => void;
};

type Props = {
  column: TableColumn;
  cell: TableCell | undefined;
  source: ColumnSource | undefined;
  cellSource: CellSource | undefined;
  active: boolean;
  /** Initial text when this field is being edited. */
  editing: string | null;
  onPick: (columnId: string, edit: boolean) => void;
  editor: FieldEditorActions;
};

const VALUE_STATE_LABEL: Record<string, string> = { ILLEGIBLE: "unreadable", DASH: "dash", NOT_APPLICABLE: "not applicable", EMPTY: "empty" };

/**
 * One cell of the row under review as a form field: label, where it was read, the value rendered with the cell
 * channels of docs/08, confidence, validation messages and whether it's reviewed.
 */
export const ReviewField = memo(function ReviewField({ column, cell, source, cellSource, active, editing, onPick, editor }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!cell) {
    return (
      <div className="text-muted-foreground rounded-md border border-dashed px-3 py-2 text-sm">
        {column.label} <span className="text-xs">· no cell for this row</span>
      </div>
    );
  }
  const visual = resolveCellVisual({ ...cell, isManual: source === "MANUAL", isSkipSourced: source === "SKIP" });
  const title = attentionTitle(cell, visual);
  const extractedText = cellText({ value: cell.extractedValue, state: cell.extractedState });
  const paths = cellSource?.paths ?? [];

  return (
    <div
      ref={ref}
      id={`review-cell-${cell.id}`}
      role="option"
      aria-selected={active}
      data-column={column.id}
      onMouseDown={(e) => {
        if (editing !== null) return;
        e.preventDefault();
        onPick(column.id, active || e.detail >= 2);
      }}
      className={cn(
        "relative flex scroll-my-2 flex-col gap-1 rounded-md border px-3 py-2",
        active ? "border-(--cell-accent) outline-2 -outline-offset-1 outline-(--cell-accent)" : "hover:border-foreground/30",
      )}
    >
      {visual.attention !== "none" ? <span aria-hidden className={cn("absolute inset-y-0 left-0 w-[3px] rounded-l-md", `cell-bar-${visual.attention}`)} /> : null}
      <div className="flex items-baseline justify-between gap-2">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-sm font-medium">
            {column.label}
            {column.isRequired ? <span className="text-muted-foreground" aria-label="required"> *</span> : null}
          </span>
          {paths.length > 0 ? (
            <span className="text-muted-foreground truncate text-xs" title={`Read from ${paths.join(", ")}`}>
              {paths.join(" + ")}
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2 text-xs">
          {cell.confidence !== null ? (
            <span className={cn("tabular-nums", visual.lowConfidence ? "text-(--attn-warn) font-medium" : "text-muted-foreground")} title="The model's own confidence in this reading">
              {visual.lowConfidence ? "uncertain · " : ""}
              {Math.round(cell.confidence * 100)}%
            </span>
          ) : null}
          {cell.isEdited ? <span className="text-muted-foreground">edited</span> : null}
          {visual.reviewed ? (
            <span className="flex items-center gap-1 text-(--value-muted)">
              <span aria-hidden className="size-[6px] rounded-full bg-(--reviewed-dot)" />
              reviewed
            </span>
          ) : (
            <span className="text-muted-foreground">not reviewed</span>
          )}
        </div>
      </div>

      {editing !== null && active ? (
        <FieldEditor initial={editing} label={column.label} editor={editor} />
      ) : (
        <div className={cn("flex min-h-9 items-center rounded px-2 text-base", `cell-authorship-${visual.authorship}`)} title={title}>
          <CellValue cell={cell} visual={visual} numeric={false} />
          {visual.semantics !== "ok" ? <span className="text-muted-foreground ml-2 text-xs">{VALUE_STATE_LABEL[cell.state] ?? ""}</span> : null}
        </div>
      )}

      {cell.isEdited || cell.disagreement ? (
        <p className="text-muted-foreground text-xs">
          Extracted:{" "}
          <span className="font-value" lang={valueLang(cell.extractedValue)}>
            {extractedText || "nothing"}
          </span>
          {cell.disagreement ? " · a new reading differs from your value (R uses the extracted value)" : ""}
        </p>
      ) : null}
      {cell.validationMsgs.length > 0 ? (
        <ul className={cn("text-xs", cell.validationState === "ERROR" ? "text-destructive" : "text-(--attn-warn)")}>
          {cell.validationMsgs.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
});

function FieldEditor({ initial, label, editor }: { initial: string; label: string; editor: FieldEditorActions }) {
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
    <input
      ref={ref}
      defaultValue={initial}
      aria-label={`${label} value`}
      className="font-value h-9 w-full rounded border px-2 text-base tabular-nums outline-2 -outline-offset-1 outline-(--cell-accent)"
      onChange={(e) => editor.draftChanged(e.target.value)}
      onBlur={(e) => {
        if (!document.hasFocus()) return;
        const value = e.target.value;
        finish(() => editor.commit(value, "stay"));
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        const value = e.currentTarget.value;
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          finish(() => editor.commit(value, "row"));
        } else if (e.key === "Enter") {
          e.preventDefault();
          finish(() => editor.commit(value, "accept"));
        } else if (e.key === "Tab") {
          e.preventDefault();
          finish(() => editor.commit(value, e.shiftKey ? "previous" : "next"));
        } else if (e.key === "Escape") {
          e.preventDefault();
          finish(() => editor.cancel());
        }
      }}
    />
  );
}
