"use client";

import { useEffect, useState } from "react";

import type { Bbox } from "@/lib/table/types";
import { cn } from "@/lib/utils";

type Props = {
  url: string;
  bbox: Bbox;
  alt: string;
  /** Tallest the crop is drawn, in pixels; a tall region is scaled down to fit rather than cut. */
  maxHeight?: number;
  className?: string;
};

/**
 * Natural sizes by object path: every row of a table page shares one photo, and each crop needs its aspect. Keyed without
 * the query string, so re-signing a link every ten minutes doesn't add an entry; a new working copy is a new path.
 */
const sizes = new Map<string, { w: number; h: number }>();

function sizeKey(url: string): string {
  return url.split("?", 1)[0] ?? url;
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/**
 * One region of a photo, cropped (Phase 20, column sweep). Boxes are normalised 0..1 on the working copy, like
 * `RegionImage`. Drawn as an SVG whose viewBox is the padded box, so the crop scales to the width it's given with no
 * measuring: a little margin around the box keeps a stroke that ran past it on screen, and the model's boxes are loose.
 */
export function RegionCrop({ url, bbox, alt, maxHeight = 96, className }: Props) {
  const [size, setSize] = useState(() => sizes.get(sizeKey(url)) ?? null);

  useEffect(() => {
    const known = sizes.get(sizeKey(url));
    if (known) {
      setSize(known);
      return;
    }
    setSize(null);
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      const s = { w: img.naturalWidth, h: img.naturalHeight };
      sizes.set(sizeKey(url), s);
      if (!cancelled) setSize(s);
    };
    img.src = url;
    return () => {
      cancelled = true;
    };
  }, [url]);

  if (!size || size.w === 0 || size.h === 0) {
    return (
      <div className={cn("bg-muted animate-pulse rounded", className)} style={{ height: maxHeight / 2 }} aria-busy="true">
        <span className="sr-only">Loading {alt}…</span>
      </div>
    );
  }

  const padY = bbox.h * 0.2 + 0.004;
  const padX = bbox.w * 0.04 + (padY * size.h) / size.w;
  const x1 = clamp01(bbox.x - padX);
  const y1 = clamp01(bbox.y - padY);
  const x2 = clamp01(bbox.x + bbox.w + padX);
  const y2 = clamp01(bbox.y + bbox.h + padY);
  const vw = Math.max((x2 - x1) * size.w, 1);
  const vh = Math.max((y2 - y1) * size.h, 1);

  return (
    <svg
      role="img"
      aria-label={alt}
      viewBox={`${x1 * size.w} ${y1 * size.h} ${vw} ${vh}`}
      preserveAspectRatio="xMinYMid meet"
      className={cn("block w-full rounded bg-white", className)}
      style={{ aspectRatio: `${vw} / ${vh}`, maxHeight }}
    >
      <image href={url} x={0} y={0} width={size.w} height={size.h} />
    </svg>
  );
}
