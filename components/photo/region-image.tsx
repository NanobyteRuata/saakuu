"use client";

import { useEffect, useRef, useState } from "react";

import type { Bbox } from "@/lib/table/types";
import { cn } from "@/lib/utils";

export type RegionBox = { bbox: Bbox; tone: "record" | "active" };

type Props = {
  url: string;
  alt: string;
  boxes: RegionBox[];
  /** Width of the image as a multiple of the viewport's width: 1 fits the page. */
  zoom: number;
  /** Region kept in the middle of the view; null leaves the scroll where it is. */
  center: Bbox | null;
  /** Dims everything outside the first `active` box (or `record` box when there is none). */
  dimOutside?: boolean;
  className?: string;
};

/**
 * A photo in a scrollable view with regions boxed, zoomed and centred on one region. Boxes are normalised 0..1 on
 * the working copy. Used by the provenance viewer and row review (docs/05 §12, §13).
 */
export function RegionImage({ url, alt, boxes, zoom, center, dimOutside = false, className }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => setLoaded(false), [url]);

  const cx = center ? center.x + center.w / 2 : null;
  const cy = center ? center.y + center.h / 2 : null;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !loaded || cx === null || cy === null) return;
    const inner = el.firstElementChild;
    if (!(inner instanceof HTMLElement)) return;
    el.scrollTo({ left: cx * inner.offsetWidth - el.clientWidth / 2, top: cy * inner.offsetHeight - el.clientHeight / 2 });
  }, [loaded, zoom, cx, cy]);

  const dimmed = dimOutside ? (boxes.find((b) => b.tone === "active") ?? boxes.find((b) => b.tone === "record")) : undefined;

  return (
    <div ref={scrollRef} className={cn("bg-muted/40 overflow-auto rounded-md border", className)}>
      <div className="relative" style={{ width: `${zoom * 100}%` }}>
        {/* eslint-disable-next-line @next/next/no-img-element -- presigned storage URL */}
        <img src={url} alt={alt} className="block w-full" onLoad={() => setLoaded(true)} />
        {boxes.map((b, i) => (
          <div
            key={`${b.tone}-${i}`}
            aria-hidden
            className={cn(
              "pointer-events-none absolute rounded-sm",
              b.tone === "active" ? "border-[3px] border-(--cell-accent) bg-(--cell-accent)/10" : "border-2 border-dashed border-(--cell-accent)/70",
              b === dimmed && "shadow-[0_0_0_9999px_rgb(0_0_0/0.25)]",
            )}
            style={{ left: `${b.bbox.x * 100}%`, top: `${b.bbox.y * 100}%`, width: `${b.bbox.w * 100}%`, height: `${b.bbox.h * 100}%` }}
          />
        ))}
      </div>
    </div>
  );
}
