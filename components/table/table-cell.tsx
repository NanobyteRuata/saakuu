"use client";

import { ChevronDown } from "lucide-react";
import { memo } from "react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { resolveCellVisual, type CellVisual } from "@/lib/table/cellState";
import type { ColumnSource, TableCell } from "@/lib/table/types";
import { cn } from "@/lib/utils";

const MYANMAR = /[\u1000-\u109F\uAA60-\uAA7F\uA9E0-\uA9FF]/u;

export function valueLang(value: string | null): string | undefined {
  return value !== null && MYANMAR.test(value) ? "my" : undefined;
}

/** Plain text for a cell, as the grid shows it: a sort key, a tooltip, a filter target. */
export function cellText(cell: Pick<TableCell, "value" | "state">): string {
  if (cell.state === "ILLEGIBLE") return "?";
  if (cell.state === "DASH") return "–";
  if (cell.state === "NOT_APPLICABLE") return "n/a";
  return cell.value ?? "";
}

const ATTENTION_LABEL: Record<Exclude<CellVisual["attention"], "none">, string> = {
  error: "Error",
  disagreement: "Disagreement",
  warning: "Check",
};

/** The attention bar's tooltip: every message, and a disagreement that a louder error hides (docs/08 §4). */
export function attentionTitle(cell: TableCell, visual: CellVisual): string | undefined {
  if (visual.attention === "none") return undefined;
  const lines = [...cell.validationMsgs];
  if (cell.disagreement) {
    lines.push(`A new reading differs from your value: extracted ${cell.extractedValue === null ? "nothing" : `“${cell.extractedValue}”`}, you entered ${cell.value === null ? "nothing" : `“${cell.value}”`}.`);
  }
  return `${ATTENTION_LABEL[visual.attention]}: ${lines.join("\n")}`;
}

export type CellActions = {
  keepMine: (cellId: string) => void;
  useExtracted: (rowId: string, cellId: string) => void;
};

type Props = {
  rowId: string;
  cell: TableCell | undefined;
  source: ColumnSource | undefined;
  threshold: number;
  width: number;
  focused: boolean;
  numeric: boolean;
  actions: CellActions;
};

/**
 * One output-table cell. Renders exactly the channels `resolveCellVisual` returns (docs/08): authorship tint,
 * value semantics with the low-confidence underline, one attention bar, the reviewed dot, and the focus ring.
 * Memoised on the cell object, so an edit re-renders only the cell it changed.
 */
export const TableCellView = memo(function TableCellView({ rowId, cell, source, threshold, width, focused, numeric, actions }: Props) {
  if (!cell) {
    return <div role="gridcell" aria-disabled className="bg-muted/40 h-full shrink-0 border-r" style={{ width }} />;
  }
  const visual = resolveCellVisual({ ...cell, isManual: source === "MANUAL", isSkipSourced: source === "SKIP" }, { confidenceThreshold: threshold });
  const title = attentionTitle(cell, visual);
  const text = cellText(cell);

  return (
    <div
      role="gridcell"
      id={`cell-${cell.id}`}
      data-cell={cell.id}
      aria-selected={focused}
      title={visual.semantics === "ok" ? text : undefined}
      className={cn(
        "relative flex h-full shrink-0 scroll-mt-14 scroll-ml-52 items-center border-r px-2 text-sm",
        `cell-authorship-${visual.authorship}`,
        "hover:outline hover:outline-1 hover:-outline-offset-1 hover:outline-(--border)",
        focused && "z-[1] outline-2 -outline-offset-2 outline-(--cell-accent) hover:outline-2 hover:outline-(--cell-accent)",
      )}
      style={{ width }}
    >
      {visual.attention !== "none" ? (
        <span
          aria-label={title}
          title={title}
          className={cn("absolute inset-y-0 left-0 w-[3px]", `cell-bar-${visual.attention}`)}
        />
      ) : null}
      {visual.reviewed ? <span aria-label="Reviewed" title="Reviewed" className="absolute top-1 right-1 size-[5px] rounded-full bg-(--reviewed-dot)" /> : null}

      <CellValue cell={cell} visual={visual} numeric={numeric} />

      {cell.disagreement ? <DisagreementButton rowId={rowId} cell={cell} actions={actions} /> : null}
    </div>
  );
});

export function CellValue({ cell, visual, numeric }: { cell: TableCell; visual: CellVisual; numeric: boolean }) {
  switch (visual.semantics) {
    case "empty":
      return <span className="sr-only">Empty</span>;
    case "dash":
      return (
        <span className="w-full text-center text-(--value-muted)" aria-label="Dash">
          –
        </span>
      );
    case "na":
      return (
        <span className="w-full text-center text-xs text-(--value-muted) [font-variant-caps:all-small-caps]" aria-label="Not applicable">
          n/a
        </span>
      );
    case "illegible":
      return (
        <span className="flex w-full justify-center">
          <span
            title="Could not be read"
            aria-label="Could not be read"
            className="bg-muted inline-flex size-4 items-center justify-center rounded-full text-[10px] font-semibold text-(--value-muted)"
          >
            ?
          </span>
        </span>
      );
    case "ok":
      return (
        <span className={cn("font-value min-w-0 truncate leading-normal tabular-nums", numeric && "ml-auto")} lang={valueLang(cell.value)}>
          {visual.authorship === "inherited" ? (
            <span aria-label="Copied from the row above (ditto): " title="Copied from the row above (ditto mark)" className="mr-1 text-[10px] text-(--value-muted)">
              ⇡
            </span>
          ) : null}
          <span className={cn(visual.lowConfidence && "cell-low-confidence")} title={visual.lowConfidence ? "The reading was uncertain" : undefined}>
            {cell.value}
          </span>
        </span>
      );
  }
}

function DisagreementButton({ rowId, cell, actions }: { rowId: string; cell: TableCell; actions: CellActions }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Compare with the new reading"
          title="Compare with the new reading"
          className="ml-1 shrink-0 rounded text-(--attn-disagree) hover:bg-(--attn-disagree)/10"
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <ChevronDown className="size-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
        <p className="text-sm font-medium">A new reading differs from your value</p>
        <dl className="mt-3 grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="text-muted-foreground">Extracted</dt>
          <dd className="font-value break-words" lang={valueLang(cell.extractedValue)}>
            {cellText({ value: cell.extractedValue, state: cell.extractedState }) || <span className="text-muted-foreground">nothing</span>}
          </dd>
          <dt className="text-muted-foreground">Yours</dt>
          <dd className="font-value break-words" lang={valueLang(cell.value)}>
            {cellText(cell) || <span className="text-muted-foreground">nothing</span>}
          </dd>
        </dl>
        <div className="mt-4 flex justify-end gap-2">
          <Button size="sm" variant="outline" onClick={() => actions.keepMine(cell.id)}>
            Keep mine
          </Button>
          <Button size="sm" onClick={() => actions.useExtracted(rowId, cell.id)}>
            Use extracted
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
