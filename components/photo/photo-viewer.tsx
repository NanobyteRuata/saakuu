"use client";

import { useEffect, useState } from "react";

import { FormMessage } from "@/components/auth/form-message";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { getJson } from "@/lib/api-client";
import type { PhotoView } from "@/lib/photos/views";
import type { Bbox } from "@/lib/table/types";

import { RegionImage } from "./region-image";

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

  useEffect(() => {
    if (!open || !photoId) return;
    let cancelled = false;
    setPhoto(null);
    setError(null);
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
            <RegionImage
              url={url}
              alt={title}
              className="h-[65vh]"
              boxes={bbox ? [{ bbox, tone: "record" }] : []}
              zoom={zoomed ? ZOOM : 1}
              center={bbox}
              dimOutside
            />
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
