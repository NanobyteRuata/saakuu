"use client";

import { useState } from "react";

import { RegionImage } from "@/components/photo/region-image";
import type { DocumentDetail, DocumentRawValues } from "@/lib/documents/service";
import type { Bbox } from "@/lib/table/types";
import { plural } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * What one reading produced, beside the page it came from (docs/05 §7). Hovering a value boxes it on
 * the photo, which is why this sits next to the image rather than under it.
 *
 * Shared by the `Try one document` dialog and the template workspace, where the page is already on
 * screen in its own pane.
 */
export const ERROR_RATE_LINE =
  "On handwriting like this, expect to correct roughly half the cells. Correcting is still much faster than typing.";

export type ReadingTally = { read: number; illegible: number; blank: number; dashOrNa: number };

/**
 * The reading's own numbers (Phase 15). The stated error rate is what we know before anyone uploads
 * anything; this is what *their* paper actually produced, which is what the line was always for.
 *
 * An empty cell, a dash and an `N/A` are three different meanings, not one (docs/01 §11.6), so a
 * dash is never counted as a blank: it is a mark the writer made on purpose.
 */
export function tallyOf(raw: DocumentRawValues): ReadingTally {
  const tally: ReadingTally = { read: 0, illegible: 0, blank: 0, dashOrNa: 0 };
  for (const record of raw.records) {
    for (const value of record.values) {
      if (value.state === "ILLEGIBLE") tally.illegible += 1;
      else if (value.state === "DASH" || value.state === "NOT_APPLICABLE") tally.dashOrNa += 1;
      else if (value.state === "OK" && value.valueText !== null && value.valueText !== "") tally.read += 1;
      else tally.blank += 1;
    }
  }
  return tally;
}

export function tallySentence(tally: ReadingTally): string {
  const parts = [`${plural(tally.read, "value")} read`, `${tally.illegible} couldn't be read`, `${tally.blank} blank`];
  // Only when the paper actually has any: a fourth number that is always zero teaches nothing.
  if (tally.dashOrNa > 0) parts.push(`${tally.dashOrNa} written as a dash or N/A`);
  return parts.join(" · ");
}

type Props = {
  raw: DocumentRawValues;
  detail: DocumentDetail | null;
  lang: string | undefined;
  /** Where the photo is drawn. Null means the caller draws it itself and only wants the values. */
  photoClassName?: string | null;
  /**
   * Told which value is under the cursor, so a caller drawing its own photo can box it there. This
   * is why the reading sits under the page in the template workspace rather than beside it.
   */
  onFocusValue?: (value: { photoId: string | null; bbox: Bbox | null } | null) => void;
  className?: string;
};

export function ReadingResult({ raw, detail, lang, photoClassName = "max-h-[50vh]", onFocusValue, className }: Props) {
  const [focus, setFocus] = useState<string | null>(null);
  const values = raw.records.flatMap((r) => r.values.map((v) => ({ ...v, recordIndex: r.recordIndex })));
  const focused = values.find((v) => `${v.recordIndex}-${v.fieldId}` === focus) ?? null;
  const show = (id: string | null) => {
    setFocus(id);
    const value = id === null ? null : (values.find((v) => `${v.recordIndex}-${v.fieldId}` === id) ?? null);
    onFocusValue?.(value === null ? null : { photoId: value.photoId, bbox: value.bbox });
  };
  const photoId = focused?.photoId ?? raw.records[0]?.photoId ?? null;
  const photo = detail?.photos.find((p) => p.id === photoId) ?? detail?.photos[0] ?? null;

  if (values.length === 0) {
    return (
      <div className={cn("flex flex-col gap-1", className)}>
        <p className="font-medium">{raw.contentState === "EMPTY" ? "This page looks blank" : "Nothing was read from this page"}</p>
        <p className="text-muted-foreground text-sm">
          {raw.contentState === "EMPTY"
            ? "That isn't a failure — a blank page reads as blank."
            : "Check that the template matches this paper, or try a sharper photo."}
        </p>
      </div>
    );
  }

  const list = (
    <div className="flex min-h-0 flex-col gap-2">
      <p className="text-muted-foreground text-sm">
        {plural(raw.totalRecords, "row")} read
        {raw.totalRecords > raw.records.length ? `, first ${raw.records.length} shown` : ""} · {tallySentence(tallyOf(raw))}. Hover
        a value to find it on the page.
      </p>
      <ul className="divide-y overflow-y-auto rounded-md border text-sm">
        {values.map((v) => {
          const id = `${v.recordIndex}-${v.fieldId}`;
          return (
            <li
              key={id}
              onMouseEnter={() => show(id)}
              onMouseLeave={() => show(null)}
              onFocus={() => show(id)}
              tabIndex={0}
              className="focus-visible:bg-muted hover:bg-muted flex items-baseline justify-between gap-3 px-3 py-1.5 outline-none"
            >
              <span className="text-muted-foreground min-w-0 truncate" lang={lang}>
                {v.path}
              </span>
              <span lang={lang} className="font-value min-w-0 truncate text-right">
                {v.state === "ILLEGIBLE" ? "Couldn’t read" : (v.valueText ?? "—")}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );

  if (photoClassName === null) return <div className={cn("flex min-h-0 flex-col", className)}>{list}</div>;

  return (
    <div className={cn("grid gap-4 md:grid-cols-2", className)}>
      <div className="flex flex-col gap-2">
        {photo?.workingUrl ? (
          <RegionImage
            url={photo.workingUrl}
            alt={raw.label ?? "The page that was read"}
            boxes={focused?.bbox ? [{ bbox: focused.bbox, tone: "active" }] : []}
            zoom={1}
            center={focused?.bbox ?? null}
            className={cn("rounded-md border", photoClassName)}
          />
        ) : (
          <p className="text-muted-foreground text-sm">The page is still rendering.</p>
        )}
      </div>
      <div className={cn("flex flex-col", photoClassName)}>{list}</div>
    </div>
  );
}
