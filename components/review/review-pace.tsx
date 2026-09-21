"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { getJson } from "@/lib/api-client";
import { formatCount, plural } from "@/lib/format";
import type { ReviewPace as Pace } from "@/lib/review/types";
import type { ReviewSource } from "@/lib/table/schemas";

const SOURCE_LABEL: Record<ReviewSource, string> = {
  CELL: "Cell by cell (Enter)",
  ROW: "Whole rows (⌘Enter)",
  ILLEGIBLE: "Unreadable (I)",
};

function secondsPerCell(seconds: number, cells: number): string {
  const s = seconds / cells;
  return `${s < 10 ? s.toFixed(1) : Math.round(s)} s per cell`;
}

/**
 * The first readout of `reviewedAt` / `reviewedVia` (docs/06 Phase 19): seconds per reviewed cell, the product's own
 * measure of success (docs/01 §1), one line per review source and never blended — a row mark stamping twelve cells at
 * one instant is not twelve fast reviews (decision 57). Fetched each time it opens; it is read, not watched.
 */
export function ReviewPace({ bookId }: { bookId: string }) {
  const [pace, setPace] = useState<Pace | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    // Last time's figures would read as current while this one is on its way.
    setPace(null);
    setError(null);
    const result = await getJson<Pace>(`/api/books/${bookId}/review-pace`);
    if (result.ok) setPace(result.data);
    else setError(result.error.message);
  }

  const reviewed = pace?.sources.filter((s) => s.cells > 0) ?? [];
  const untimed = reviewed.reduce((n, s) => n + s.cells - s.timedCells, 0);

  return (
    <Popover onOpenChange={(open) => open && void load()}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" onMouseDown={(e) => e.preventDefault()}>
          Pace
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80" onCloseAutoFocus={(e) => e.preventDefault()}>
        <p className="text-sm font-medium">Seconds per reviewed cell</p>
        {error ? (
          <p className="text-destructive mt-2 text-sm">{error}</p>
        ) : !pace ? (
          <p className="text-muted-foreground mt-2 text-sm">Loading…</p>
        ) : reviewed.length === 0 ? (
          <p className="text-muted-foreground mt-2 text-sm">No cells reviewed in this book yet.</p>
        ) : (
          <>
            <dl className="mt-2 flex flex-col gap-1.5 text-sm" aria-label="Pace by how cells were reviewed">
              {reviewed.map((s) => (
                <div key={s.via} className="flex items-baseline justify-between gap-3">
                  <dt>{SOURCE_LABEL[s.via]}</dt>
                  <dd className="text-muted-foreground text-right tabular-nums">
                    {s.timedCells > 0 ? `${secondsPerCell(s.seconds, s.timedCells)} · ` : "not timed · "}
                    {plural(s.cells, "cell")}
                  </dd>
                </div>
              ))}
            </dl>
            <p className="text-muted-foreground mt-3 text-xs">
              Each figure is the time since the previous review, spread over the cells it marked. Pauses over {Math.round(pace.breakSeconds / 60)} minutes count as
              breaks
              {untimed > 0 ? `: ${formatCount(untimed)} ${untimed === 1 ? "cell is" : "cells are"} counted but not timed.` : "."}
            </p>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
