"use client";

import { useEffect, useRef, useState } from "react";

import { FormMessage } from "@/components/auth/form-message";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { getJson } from "@/lib/api-client";
import type { PhotoView } from "@/lib/photos/views";
import type { Bbox } from "@/lib/table/types";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  photoId: string | null;
  /** Region to box, normalised 0..1 on the working copy. */
  bbox: Bbox | null;
  title: string;
  description: string;
};

const ZOOM = 2.5;

/** A source photo with a record's region boxed, opened zoomed to that region (docs/05 §12 provenance). */
export function PhotoViewer({ open, onOpenChange, photoId, bbox, title, description }: Props) {
  const [photo, setPhoto] = useState<PhotoView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoomed, setZoomed] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || !photoId) return;
    let cancelled = false;
    setPhoto(null);
    setError(null);
    setLoaded(false);
    setZoomed(bbox !== null);
    void getJson<PhotoView[]>(`/api/photos/status?ids=${photoId}`).then((result) => {
      if (cancelled) return;
      if (!result.ok) setError(result.error.message);
      else if (!result.data[0]) setError("This photo was deleted.");
      else setPhoto(result.data[0]);
    });
    return () => {
      cancelled = true;
    };
  }, [open, photoId, bbox]);

  // Centre the boxed region once the image has its size.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !loaded || !bbox) return;
    const inner = el.firstElementChild;
    if (!(inner instanceof HTMLElement)) return;
    el.scrollTo({
      left: (bbox.x + bbox.w / 2) * inner.offsetWidth - el.clientWidth / 2,
      top: (bbox.y + bbox.h / 2) * inner.offsetHeight - el.clientHeight / 2,
    });
  }, [loaded, zoomed, bbox]);

  const url = photo?.workingUrl ?? photo?.thumbUrl ?? null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[92vh] flex-col sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle className="truncate">{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {!photoId ? (
          <p className="text-muted-foreground py-10 text-center text-sm">This row has no source photo recorded, so there&apos;s no region to show.</p>
        ) : error ? (
          <FormMessage tone="error">{error}</FormMessage>
        ) : !url ? (
          <div className="bg-muted h-[60vh] animate-pulse rounded-md" aria-busy="true">
            <span className="sr-only">Loading photo…</span>
          </div>
        ) : (
          <>
            <div ref={scrollRef} className="bg-muted/40 h-[65vh] overflow-auto rounded-md border">
              <div className="relative" style={{ width: zoomed ? `${ZOOM * 100}%` : "100%" }}>
                {/* eslint-disable-next-line @next/next/no-img-element -- presigned storage URL */}
                <img src={url} alt={title} className="block w-full" onLoad={() => setLoaded(true)} />
                {bbox ? (
                  <div
                    aria-hidden
                    className="pointer-events-none absolute rounded-sm border-2 border-(--cell-accent) bg-(--cell-accent)/10 shadow-[0_0_0_9999px_rgb(0_0_0/0.25)]"
                    style={{ left: `${bbox.x * 100}%`, top: `${bbox.y * 100}%`, width: `${bbox.w * 100}%`, height: `${bbox.h * 100}%` }}
                  />
                ) : null}
              </div>
            </div>
            <div className="flex items-center justify-between gap-3">
              <p className="text-muted-foreground text-xs">{bbox ? "The boxed region is where this row was read." : "No region was recorded for this row; showing the whole page."}</p>
              {bbox ? (
                <Button variant="outline" size="sm" onClick={() => setZoomed((z) => !z)}>
                  {zoomed ? "Show whole page" : "Zoom to row"}
                </Button>
              ) : null}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
