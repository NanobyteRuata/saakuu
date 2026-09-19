"use client";

import { RotateCcw, RotateCw, Wand2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { toast } from "sonner";

import { FormMessage } from "@/components/auth/form-message";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { patchJson, postJson } from "@/lib/api-client";
import {
  isIdentity,
  MAX_DESKEW_DEGREES,
  normalizeTransform,
  rescaleCrop,
  rotatedSize,
  type Crop,
  type PhotoTransform,
} from "@/lib/photos/transform";
import type { PhotoView } from "@/lib/photos/views";
import { cn } from "@/lib/utils";

type Props = {
  photo: PhotoView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (photo: PhotoView) => void;
};

const FULL: Crop = { x: 0, y: 0, w: 1, h: 1 };
const MIN_CROP = 0.03;
const FINE_LIMIT = 45;

type Handle = "move" | "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

function splitRotate(rotate: number): { quarter: number; fine: number } {
  const quarter = ((Math.round(rotate / 90) * 90) % 360 + 360) % 360;
  let fine = rotate - Math.round(rotate / 90) * 90;
  fine = Math.max(-FINE_LIMIT, Math.min(FINE_LIMIT, Math.round(fine * 10) / 10));
  return { quarter, fine };
}

function clampCrop(c: Crop): Crop {
  const w = Math.min(1, Math.max(MIN_CROP, c.w));
  const h = Math.min(1, Math.max(MIN_CROP, c.h));
  return { x: Math.min(1 - w, Math.max(0, c.x)), y: Math.min(1 - h, Math.max(0, c.y)), w, h };
}

function resize(start: Crop, handle: Handle, dx: number, dy: number): Crop {
  if (handle === "move") return clampCrop({ ...start, x: start.x + dx, y: start.y + dy });
  let { x, y, w, h } = start;
  const right = x + w;
  const bottom = y + h;
  if (handle.includes("w")) {
    x = Math.min(right - MIN_CROP, Math.max(0, start.x + dx));
    w = right - x;
  }
  if (handle.includes("e")) w = Math.min(1 - x, Math.max(MIN_CROP, start.w + dx));
  if (handle.includes("n")) {
    y = Math.min(bottom - MIN_CROP, Math.max(0, start.y + dy));
    h = bottom - y;
  }
  if (handle.includes("s")) h = Math.min(1 - y, Math.max(MIN_CROP, start.h + dy));
  return { x, y, w, h };
}

/**
 * Photo editor (docs/05 §10). Crop, rotate, deskew and reset edit a transform JSON only. The
 * preview uses the same geometry as the server render (lib/photos/transform.ts): the image rotates
 * about its centre inside its expanded bounding box, and the crop is normalised to that box.
 */
export function PhotoEditor({ photo, open, onOpenChange, onSaved }: Props) {
  const initial = normalizeTransform(photo.transform);
  const split = splitRotate(initial.rotate);
  const [quarter, setQuarter] = useState(split.quarter);
  const [fine, setFine] = useState(split.fine);
  const [deskew, setDeskew] = useState(initial.deskew);
  const [crop, setCrop] = useState<Crop>(initial.crop ?? FULL);
  const [showGrid, setShowGrid] = useState(false);
  const [saving, setSaving] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [imageLoaded, setImageLoaded] = useState(false);
  const [area, setArea] = useState({ width: 0, height: 0 });
  const drag = useRef<{ handle: Handle; startX: number; startY: number; start: Crop } | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);

  // Callback ref: the dialog mounts its content after this component's first commit, so an effect
  // would run before the element exists and never measure it.
  const areaRef = useCallback((el: HTMLDivElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!el) return;
    setArea({ width: el.clientWidth, height: el.clientHeight });
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setArea({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(el);
    observerRef.current = observer;
  }, []);

  const rotate = quarter + fine;
  const angle = rotate + deskew;
  const width = photo.width || 1;
  const height = photo.height || 1;
  const box = rotatedSize(width, height, angle);
  const scale = area.width > 0 ? Math.min(area.width / box.width, area.height / box.height) : 0;
  const stage = { width: box.width * scale, height: box.height * scale };
  const fullCrop = crop.x <= 0 && crop.y <= 0 && crop.w >= 1 && crop.h >= 1;

  const draft: PhotoTransform = normalizeTransform({ rotate, deskew, crop: fullCrop ? null : crop });

  // Fine rotation and deskew change the rotated bounding box the crop is normalised to; rescale the
  // crop so it stays on the same part of the page instead of drifting. (A 90° turn clears it.)
  const prevBox = useRef(box);
  useEffect(() => {
    const from = prevBox.current;
    prevBox.current = box;
    if (from.width === box.width && from.height === box.height) return;
    setCrop((c) => rescaleCrop(c, from, box));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- box is derived from these two numbers
  }, [box.width, box.height]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);

  useEffect(() => {
    const move = (e: PointerEvent) => {
      const d = drag.current;
      if (!d || stage.width === 0) return;
      setCrop(resize(d.start, d.handle, (e.clientX - d.startX) / stage.width, (e.clientY - d.startY) / stage.height));
    };
    const up = () => {
      drag.current = null;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [stage.width, stage.height]);

  function startDrag(handle: Handle) {
    return (e: ReactPointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      drag.current = { handle, startX: e.clientX, startY: e.clientY, start: crop };
    };
  }

  function nudge(e: React.KeyboardEvent) {
    const step = e.altKey ? 0.002 : 0.01;
    const keys: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const delta = keys[e.key];
    if (!delta) return;
    e.preventDefault();
    setCrop((c) => (e.shiftKey ? resize(c, "se", delta[0], delta[1]) : resize(c, "move", delta[0], delta[1])));
  }

  function turn(by: number) {
    setQuarter((q) => (((q + by) % 360) + 360) % 360);
    setCrop(FULL);
  }

  async function autoDeskew() {
    setDetecting(true);
    setError(null);
    const result = await postJson<{ deskew: number }>(`/api/photos/${photo.id}/autodeskew`, { rotate });
    setDetecting(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setDeskew(result.data.deskew);
    setShowGrid(true);
    toast.success(result.data.deskew === 0 ? "This page already looks straight." : `Straightened by ${result.data.deskew}°. Check it against the grid.`);
  }

  function reset() {
    setQuarter(0);
    setFine(0);
    setDeskew(0);
    setCrop(FULL);
  }

  async function save() {
    setSaving(true);
    setError(null);
    const result = isIdentity(draft)
      ? await postJson<PhotoView>(`/api/photos/${photo.id}/transform/reset`, {})
      : await patchJson<PhotoView>(`/api/photos/${photo.id}/transform`, { rotate: draft.rotate, deskew: draft.deskew, crop: draft.crop });
    setSaving(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    toast.success("Saved. The original photo is unchanged.");
    onSaved(result.data);
  }

  const handles: { h: Handle; className: string }[] = [
    { h: "nw", className: "-top-1.5 -left-1.5 cursor-nwse-resize" },
    { h: "ne", className: "-top-1.5 -right-1.5 cursor-nesw-resize" },
    { h: "sw", className: "-bottom-1.5 -left-1.5 cursor-nesw-resize" },
    { h: "se", className: "-right-1.5 -bottom-1.5 cursor-nwse-resize" },
    { h: "n", className: "-top-1.5 left-1/2 -translate-x-1/2 cursor-ns-resize" },
    { h: "s", className: "-bottom-1.5 left-1/2 -translate-x-1/2 cursor-ns-resize" },
    { h: "w", className: "top-1/2 -left-1.5 -translate-y-1/2 cursor-ew-resize" },
    { h: "e", className: "top-1/2 -right-1.5 -translate-y-1/2 cursor-ew-resize" },
  ];

  return (
    <Dialog open={open} onOpenChange={(next) => !saving && onOpenChange(next)}>
      <DialogContent className="flex h-[calc(100vh-2rem)] max-w-[calc(100%-2rem)] flex-col gap-3 sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>Edit photo</DialogTitle>
          <DialogDescription>
            Crop, turn and straighten this page. Only these settings are saved; the original photo is never changed.
          </DialogDescription>
        </DialogHeader>

        <div ref={areaRef} className="bg-muted/60 relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-md">
          {!photo.baseUrl ? (
            <p className="text-muted-foreground text-sm">This photo is still being processed.</p>
          ) : (
            <div className="relative overflow-hidden bg-white shadow" style={{ width: stage.width, height: stage.height }}>
              {/* eslint-disable-next-line @next/next/no-img-element -- presigned storage URL */}
              <img
                src={photo.baseUrl}
                alt="Photo being edited"
                draggable={false}
                onLoad={() => setImageLoaded(true)}
                className="pointer-events-none absolute top-1/2 left-1/2 max-w-none select-none"
                style={{
                  width: width * scale,
                  height: height * scale,
                  transform: `translate(-50%, -50%) rotate(${angle}deg)`,
                }}
              />
              {showGrid ? (
                <div
                  aria-hidden
                  className="pointer-events-none absolute inset-0"
                  style={{
                    backgroundImage:
                      "linear-gradient(to right, rgba(59,130,246,.45) 1px, transparent 1px), linear-gradient(to bottom, rgba(59,130,246,.45) 1px, transparent 1px)",
                    backgroundSize: `${stage.width / 12}px ${stage.height / 12}px`,
                  }}
                />
              ) : null}
              <div
                role="group"
                tabIndex={0}
                aria-label="Crop area. Arrow keys move it; Shift with arrow keys resizes it."
                onKeyDown={nudge}
                onPointerDown={startDrag("move")}
                className="focus-visible:ring-primary absolute cursor-move border-2 border-white outline-none focus-visible:ring-2"
                style={{
                  left: crop.x * stage.width,
                  top: crop.y * stage.height,
                  width: crop.w * stage.width,
                  height: crop.h * stage.height,
                  boxShadow: "0 0 0 9999px rgba(0,0,0,.45)",
                }}
              >
                {handles.map(({ h, className }) => (
                  <span
                    key={h}
                    aria-hidden
                    onPointerDown={startDrag(h)}
                    className={cn("absolute size-3 rounded-sm border border-black/40 bg-white", className)}
                  />
                ))}
              </div>
            </div>
          )}
          {photo.baseUrl && !imageLoaded ? <p className="text-muted-foreground absolute text-sm">Loading photo…</p> : null}
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <div className="flex flex-col gap-2">
            <Label>Turn</Label>
            <div className="flex gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => turn(-90)}>
                <RotateCcw />
                90° left
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => turn(90)}>
                <RotateCw />
                90° right
              </Button>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <span className="w-10 shrink-0">Fine</span>
              <input
                type="range"
                min={-FINE_LIMIT}
                max={FINE_LIMIT}
                step={0.5}
                value={fine}
                onChange={(e) => setFine(Number(e.target.value))}
                className="flex-1"
                aria-label="Fine rotation in degrees"
              />
              <span className="w-12 text-right tabular-nums">{fine}°</span>
            </label>
          </div>
          <div className="flex flex-col gap-2">
            <Label>Straighten (deskew)</Label>
            <Button type="button" variant="outline" size="sm" className="self-start" onClick={autoDeskew} disabled={detecting || !photo.baseUrl}>
              <Wand2 />
              {detecting ? "Detecting…" : "Auto-detect"}
            </Button>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="range"
                min={-MAX_DESKEW_DEGREES}
                max={MAX_DESKEW_DEGREES}
                step={0.1}
                value={deskew}
                onChange={(e) => setDeskew(Number(e.target.value))}
                onPointerDown={() => setShowGrid(true)}
                className="flex-1"
                aria-label="Deskew angle in degrees"
              />
              <span className="w-12 text-right tabular-nums">{deskew}°</span>
            </label>
          </div>
          <div className="flex flex-col gap-2">
            <Label>Crop</Label>
            <p className="text-muted-foreground text-xs">Drag the edges or corners of the bright area. Drag inside it to move it.</p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => setCrop(FULL)} disabled={fullCrop}>
                Remove crop
              </Button>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={showGrid} onChange={(e) => setShowGrid(e.target.checked)} />
                Grid
              </label>
            </div>
          </div>
        </div>

        <p className="text-muted-foreground text-xs">
          Saving changes what the AI reads for this page, so the document is marked{" "}
          <span className="text-foreground">Changed since last read</span> until you extract it again. You don&apos;t have
          to remember which pages you edited — the Documents tab can filter for them.
        </p>
        {error ? <FormMessage tone="error">{error}</FormMessage> : null}

        <DialogFooter className="sm:justify-between">
          <Button type="button" variant="ghost" onClick={reset} disabled={saving || isIdentity(draft)}>
            Reset
          </Button>
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
              Cancel
            </Button>
            <Button type="button" onClick={save} disabled={saving || !dirty}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
