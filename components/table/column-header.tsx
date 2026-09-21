"use client";

import { ArrowDown, ArrowUp, CircleAlert, CircleDashed, Filter, TriangleAlert, Unplug } from "lucide-react";
import Link from "next/link";
import { memo, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { patchJson } from "@/lib/api-client";
import { DATE_ERA_LABELS, NUMERAL_SYSTEM_LABELS } from "@/lib/books/labels";
import { COLUMN_TYPE_LABELS, DATE_ERAS } from "@/lib/books/schemas";
import { formatCount, plural } from "@/lib/format";
import type { TableColumn } from "@/lib/table/types";
import { CONVERTED_TYPES, type ColumnFilter } from "@/lib/table/view";
import type { DateEra, NumeralSystem } from "@/lib/transform/types";
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
  /** Cells the transform could not convert to this column's type, which one book setting can fix. */
  unparsed: number;
  unfilled: boolean;
  bookId: string;
  numeralSystem: NumeralSystem;
  dateEra: DateEra;
  sort: SortDirection;
  filter: ColumnFilter | undefined;
  onSort: (columnId: string, direction: SortDirection) => void;
  onFilter: (columnId: string, filter: ColumnFilter | undefined) => void;
  /** Accepting the offer below changed a book setting, so the rows are being rebuilt. */
  onBookSettingChanged: (columnId: string) => void;
};

/**
 * Numerals and eras describe the paper, not the book, and an operator does not know up front what
 * "Myanmar era" will do to their data. So they are not configured: they are offered here, on the
 * column whose values did not convert, with the fix in place (decision 76).
 */
function ParseFix({
  column,
  unparsed,
  bookId,
  numeralSystem,
  dateEra,
  onChanged,
}: {
  column: TableColumn;
  unparsed: number;
  bookId: string;
  numeralSystem: NumeralSystem;
  dateEra: DateEra;
  onChanged: (columnId: string) => void;
}) {
  const [pending, setPending] = useState(false);
  const isDate = column.dataType === "DATE";
  // Always the other two, since a book is on exactly one era.
  const eras = DATE_ERAS.filter((era) => era !== dateEra);
  // Myanmar numerals are already read when a value contains them; settling the book on Myanmar is what
  // makes the transform treat the letter ဝ as a zero (lib/transform/numerals.ts). Once it is settled
  // there is nothing left to offer a number column.
  if (!isDate && numeralSystem === "MYANMAR") return null;

  async function apply(patch: { dateEra: DateEra } | { numeralSystem: NumeralSystem }, label: string) {
    setPending(true);
    const result = await patchJson(`/api/books/${bookId}`, patch);
    setPending(false);
    if (!result.ok) {
      toast.error(result.error.message);
      return;
    }
    toast.success(`Reading this book as ${label}. Rebuilding rows…`);
    onChanged(column.id);
  }

  return (
    <div className="bg-(--attn-warn)/10 border-(--attn-warn)/40 m-1 flex flex-col gap-2 rounded-md border p-2">
      <p className="text-sm font-medium">
        {formatCount(unparsed)} {isDate ? (unparsed === 1 ? "date isn't" : "dates aren't") : unparsed === 1 ? "number isn't" : "numbers aren't"} parsing in this column.
      </p>
      <p className="text-muted-foreground text-xs">
        {isDate ? "Is this paper using the Myanmar era, or Buddhist-era years?" : "Is this paper using Burmese digits?"} It describes the paper, so it is set for
        the whole book. Rows rebuild from what the AI already read — no AI cost.
      </p>
      <div className="flex flex-wrap gap-1">
        {isDate
          ? eras.map((era) => (
              <Button key={era} size="sm" variant="outline" disabled={pending} onClick={() => void apply({ dateEra: era }, DATE_ERA_LABELS[era])}>
                {DATE_ERA_LABELS[era]}
              </Button>
            ))
          : (
              <Button size="sm" variant="outline" disabled={pending} onClick={() => void apply({ numeralSystem: "MYANMAR" }, NUMERAL_SYSTEM_LABELS.MYANMAR)}>
                {NUMERAL_SYSTEM_LABELS.MYANMAR}
              </Button>
            )}
      </div>
    </div>
  );
}

/** Label, type, error and unreviewed counts, and a menu for view-only sort and filter (docs/05 §12). */
export const ColumnHeader = memo(function ColumnHeader({ column, width, errors, unreviewed, unparsed, unfilled, bookId, numeralSystem, dateEra, sort, filter, onSort, onFilter, onBookSettingChanged }: Props) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(filter?.kind === "contains" ? filter.text : "");
  const set = (next: ColumnFilter | undefined) => {
    onFilter(column.id, next);
    setOpen(false);
  };
  const offerFix = unparsed > 0 && CONVERTED_TYPES.has(column.dataType);

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
          {offerFix ? (
            <>
              <ParseFix
                column={column}
                unparsed={unparsed}
                bookId={bookId}
                numeralSystem={numeralSystem}
                dateEra={dateEra}
                onChanged={(columnId) => {
                  setOpen(false);
                  onBookSettingChanged(columnId);
                }}
              />
              <div className="my-2 border-t" />
            </>
          ) : null}
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
          <Link
            href={`/books/${bookId}/review/sweep?column=${column.id}`}
            className="hover:bg-muted block w-full rounded px-2 py-1 text-left text-sm"
            title="Review this column down every document, each value beside where it was read"
          >
            Sweep this column{unreviewed > 0 ? ` · ${formatCount(unreviewed)} unreviewed` : ""}
          </Link>
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
        {offerFix ? (
          <span
            className="flex shrink-0 items-center gap-0.5 text-(--attn-warn)"
            title={`${plural(unparsed, "value")} here didn't convert to ${COLUMN_TYPE_LABELS[column.dataType]}. Open this column's menu: it may be the book's era or numerals.`}
          >
            <TriangleAlert className="size-3" aria-hidden />
            {formatCount(unparsed)} not parsing
          </span>
        ) : null}
        {unfilled ? (
          <span
            className="flex shrink-0 items-center gap-0.5 text-(--attn-warn)"
            title="No template maps a field to this column, so it stays blank. Add a mapping in a template."
          >
            <Unplug className="size-3" aria-hidden />
            Not filled
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
