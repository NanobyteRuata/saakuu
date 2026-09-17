"use client";

import { ArrowDown, ArrowUp, CircleAlert, CircleDashed, Filter } from "lucide-react";
import { memo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { COLUMN_TYPE_LABELS } from "@/lib/books/schemas";
import { formatCount } from "@/lib/format";
import type { TableColumn } from "@/lib/table/types";
import type { ColumnFilter } from "@/lib/table/view";
import { cn } from "@/lib/utils";

export const COLUMN_FILTER_LABELS: Record<Exclude<ColumnFilter["kind"], "contains">, string> = {
  attention: "Needs attention",
  errors: "Errors",
  warnings: "Warnings",
  edited: "Edited",
  unreviewed: "Not reviewed",
  empty: "Empty",
};

export type SortDirection = "asc" | "desc" | false;

type Props = {
  column: TableColumn;
  width: number;
  errors: number;
  unreviewed: number;
  sort: SortDirection;
  filter: ColumnFilter | undefined;
  onSort: (columnId: string, direction: SortDirection) => void;
  onFilter: (columnId: string, filter: ColumnFilter | undefined) => void;
};

/** Label, type, error and unreviewed counts, and a menu for view-only sort and filter (docs/05 §12). */
export const ColumnHeader = memo(function ColumnHeader({ column, width, errors, unreviewed, sort, filter, onSort, onFilter }: Props) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(filter?.kind === "contains" ? filter.text : "");
  const set = (next: ColumnFilter | undefined) => {
    onFilter(column.id, next);
    setOpen(false);
  };

  return (
    <div role="columnheader" aria-sort={sort === "asc" ? "ascending" : sort === "desc" ? "descending" : "none"} className="flex h-full shrink-0 flex-col justify-center gap-0.5 overflow-hidden border-r px-2" style={{ width }}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button type="button" className="hover:bg-muted -mx-1 flex min-w-0 items-center gap-1 rounded px-1 text-left text-sm font-medium" title={`${column.label} (${column.key}): sort and filter`}>
            <span className="truncate">{column.label}</span>
            {column.isRequired ? <span aria-label="required" className="text-muted-foreground">*</span> : null}
            {sort === "asc" ? <ArrowUp aria-label="sorted ascending" className="size-3.5 shrink-0" /> : sort === "desc" ? <ArrowDown aria-label="sorted descending" className="size-3.5 shrink-0" /> : null}
            {filter ? <Filter aria-label="filtered" className="size-3.5 shrink-0 fill-current" /> : null}
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-64 p-2">
          <p className="text-muted-foreground px-2 pt-1 pb-2 text-xs">Sorting only changes your view. The saved row order stays as it is.</p>
          <div className="flex gap-1 px-1">
            <Button size="sm" variant={sort === "asc" ? "secondary" : "ghost"} onClick={() => onSort(column.id, sort === "asc" ? false : "asc")}>
              <ArrowUp className="size-3.5" /> Ascending
            </Button>
            <Button size="sm" variant={sort === "desc" ? "secondary" : "ghost"} onClick={() => onSort(column.id, sort === "desc" ? false : "desc")}>
              <ArrowDown className="size-3.5" /> Descending
            </Button>
          </div>
          <div className="my-2 border-t" />
          <p className="px-2 pb-1 text-xs font-medium">Show only cells that are</p>
          <div className="flex flex-col" role="radiogroup" aria-label={`Filter ${column.label}`}>
            {(Object.keys(COLUMN_FILTER_LABELS) as (keyof typeof COLUMN_FILTER_LABELS)[]).map((kind) => (
              <button
                key={kind}
                type="button"
                role="radio"
                aria-checked={filter?.kind === kind}
                className={cn("hover:bg-muted rounded px-2 py-1 text-left text-sm", filter?.kind === kind && "bg-muted font-medium")}
                onClick={() => set(filter?.kind === kind ? undefined : { kind })}
              >
                {COLUMN_FILTER_LABELS[kind]}
              </button>
            ))}
          </div>
          <form
            className="mt-2 flex gap-1 px-1"
            onSubmit={(e) => {
              e.preventDefault();
              set(text.trim() ? { kind: "contains", text: text.trim() } : undefined);
            }}
          >
            <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Containing…" aria-label="Containing text" className="h-8" />
            <Button type="submit" size="sm" variant="outline">
              Apply
            </Button>
          </form>
          {filter ? (
            <Button size="sm" variant="ghost" className="mt-1 w-full" onClick={() => set(undefined)}>
              Clear filter
            </Button>
          ) : null}
          <div className="my-2 border-t" />
          <button type="button" disabled className="text-muted-foreground w-full cursor-not-allowed px-2 py-1 text-left text-sm" title="Column sweep review is coming later">
            Sweep this column (coming later)
          </button>
        </PopoverContent>
      </Popover>
      <div className="text-muted-foreground flex min-w-0 items-center gap-1.5 overflow-hidden text-xs font-normal whitespace-nowrap">
        <span className="min-w-0 truncate rounded border px-1 text-[10px] leading-4">{COLUMN_TYPE_LABELS[column.dataType]}</span>
        {errors > 0 ? (
          <span className="flex shrink-0 items-center gap-0.5 text-(--attn-error)" title={`${formatCount(errors)} ${errors === 1 ? "cell has" : "cells have"} errors`}>
            <CircleAlert className="size-3" aria-hidden />
            {formatCount(errors)}
            <span className="sr-only"> errors</span>
          </span>
        ) : null}
        {unreviewed > 0 ? (
          <span className="flex shrink-0 items-center gap-0.5" title={`${formatCount(unreviewed)} not reviewed`}>
            <CircleDashed className="size-3" aria-hidden />
            {formatCount(unreviewed)}
            <span className="sr-only"> not reviewed</span>
          </span>
        ) : null}
      </div>
    </div>
  );
});
