"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

import type { Bbox } from "@/lib/table/types";
import { cn } from "@/lib/utils";

export type RegionBox = { bbox: Bbox; tone: "record" | "active" };

type Props = {
  url: string;
  alt: string;
  boxes: RegionBox[];
  /** Width of the image as a multiple of the viewport's width: 1 fits the page. */
  zoom: number;
  /**
   * Makes zoom controlled: gestures report here and the caller passes the new `zoom` back. Without
   * it a gesture zooms locally until `zoom` or `center` changes, which hands the view back.
   */
  onZoomChange?: (zoom: number) => void;
  minZoom?: number;
  maxZoom?: number;
  /** Region kept in the middle of the view; null leaves the scroll where it is. */
  center: Bbox | null;
  /** Dims everything outside the first `active` box (or `record` box when there is none). */
  dimOutside?: boolean;
  className?: string;
};

/** Safari's trackpad pinch; not in lib.dom. */
type GestureEvent = UIEvent & { scale: number; clientX: number; clientY: number };

/** The content point under the cursor, and the zoom it should be pinned at. */
type Anchor = { fx: number; fy: number; px: number; py: number; target: number };

/** A mouse notch is ~100px of deltaY, a trackpad pinch a few; capped so one notch is at most ~1.65×. */
const WHEEL_DELTA_CAP = 50;

/**
 * A photo in a scrollable view with regions boxed, zoomed and centred on one region. Boxes are normalised 0..1 on
 * the working copy.
 *
 * Pinch or ⌘/Ctrl-scroll zooms about the cursor; dragging pans. Touch is handled here too, one finger
 * panning and two pinching, because a native one-finger scroll cancels the pointer a pinch starts from.
 */
export function RegionImage({ url, alt, boxes, zoom, onZoomChange, minZoom = 1, maxZoom = 8, center, dimOutside = false, className }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [loaded, setLoaded] = useState(false);
  const [dragging, setDragging] = useState(false);
  /** Whether there is anything to drag: the page is larger than the view. */
  const [pannable, setPannable] = useState(false);

  // A cached image can finish loading before this runs, and its onLoad would then be overwritten.
  useEffect(() => {
    const img = imgRef.current;
    setLoaded(img !== null && img.complete && img.naturalWidth > 0);
  }, [url]);

  const cx = center ? center.x + center.w / 2 : null;
  const cy = center ? center.y + center.h / 2 : null;

  // Uncontrolled: a gesture's zoom lasts until the caller moves the view itself.
  const [override, setOverride] = useState<number | null>(null);
  const [base, setBase] = useState({ zoom, cx, cy });
  if (base.zoom !== zoom || base.cx !== cx || base.cy !== cy) {
    setBase({ zoom, cx, cy });
    setOverride(null);
  }
  const effective = onZoomChange ? zoom : (override ?? zoom);

  const zoomRef = useRef(effective);
  zoomRef.current = effective;
  const anchor = useRef<Anchor | null>(null);
  const skipCenter = useRef(false);

  /** Zooms to `next`, keeping the content under the client point where it is on screen. */
  const zoomTo = useRef<(next: number, clientX: number, clientY: number) => void>(() => undefined);
  zoomTo.current = (next, clientX, clientY) => {
    const el = scrollRef.current;
    const inner = el?.firstElementChild;
    // Until the image loads the content has no height to anchor to.
    if (!el || !(inner instanceof HTMLElement) || !loaded || inner.offsetHeight === 0) return;
    const clamped = Math.min(Math.max(next, minZoom), maxZoom);
    if (Math.abs(clamped - zoomRef.current) < 0.001) return;
    const rect = el.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    anchor.current = { fx: (el.scrollLeft + px) / inner.offsetWidth, fy: (el.scrollTop + py) / inner.offsetHeight, px, py, target: clamped };
    if (onZoomChange) onZoomChange(clamped);
    else setOverride(clamped);
  };

  useLayoutEffect(() => {
    const el = scrollRef.current;
    const inner = el?.firstElementChild;
    const a = anchor.current;
    if (!el || !(inner instanceof HTMLElement) || !a) return;
    anchor.current = null;
    // A caller that clamped or ignored the gesture: this change isn't the one the anchor was for.
    if (Math.abs(a.target - effective) > 0.001) return;
    skipCenter.current = true;
    el.scrollLeft = a.fx * inner.offsetWidth - a.px;
    el.scrollTop = a.fy * inner.offsetHeight - a.py;
  }, [effective]);

  useEffect(() => {
    if (skipCenter.current) {
      skipCenter.current = false;
      return;
    }
    const el = scrollRef.current;
    if (!el || !loaded || cx === null || cy === null) return;
    const inner = el.firstElementChild;
    if (!(inner instanceof HTMLElement)) return;
    el.scrollTo({ left: cx * inner.offsetWidth - el.clientWidth / 2, top: cy * inner.offsetHeight - el.clientHeight / 2 });
  }, [loaded, effective, cx, cy]);

  // Non-passive, so the browser's own page zoom can be stopped.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let gestureStart = 1;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const delta = Math.max(-WHEEL_DELTA_CAP, Math.min(WHEEL_DELTA_CAP, e.deltaY));
      zoomTo.current(zoomRef.current * Math.exp(-delta * 0.01), e.clientX, e.clientY);
    };
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      gestureStart = zoomRef.current;
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      const g = e as GestureEvent;
      zoomTo.current(gestureStart * g.scale, g.clientX, g.clientY);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("gesturestart", onGestureStart);
    el.addEventListener("gesturechange", onGestureChange);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("gesturestart", onGestureStart);
      el.removeEventListener("gesturechange", onGestureChange);
    };
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    const inner = el?.firstElementChild;
    if (!el || !(inner instanceof HTMLElement)) return;
    const measure = () => setPannable(el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1);
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    observer.observe(inner);
    return () => observer.disconnect();
  }, []);

  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ dist: number; zoom: number } | null>(null);

  function pinchState() {
    const [a, b] = [...pointers.current.values()];
    if (!a || !b) return null;
    return { dist: Math.hypot(a.x - b.x, a.y - b.y), midX: (a.x + b.x) / 2, midY: (a.y + b.y) / 2 };
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.pointerType === "mouse" && (e.button !== 0 || !pannable)) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const p = pinchState();
    if (p && p.dist > 0) {
      pinch.current = { dist: p.dist, zoom: zoomRef.current };
      setDragging(false);
    } else {
      setDragging(true);
    }
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const last = pointers.current.get(e.pointerId);
    if (!last) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const p = pinchState();
    if (p && pinch.current) {
      zoomTo.current((pinch.current.zoom * p.dist) / pinch.current.dist, p.midX, p.midY);
      return;
    }
    const el = scrollRef.current;
    if (!el) return;
    el.scrollLeft -= e.clientX - last.x;
    el.scrollTop -= e.clientY - last.y;
  }

  function onPointerEnd(e: React.PointerEvent<HTMLDivElement>) {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    // The finger left on the glass after a pinch carries on panning from where it is.
    setDragging(pointers.current.size === 1);
  }

  const dimmed = dimOutside ? (boxes.find((b) => b.tone === "active") ?? boxes.find((b) => b.tone === "record")) : undefined;

  return (
    <div
      ref={scrollRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      className={cn(
        "bg-muted/40 touch-none overflow-auto rounded-md border select-none",
        pannable && (dragging ? "cursor-grabbing" : "cursor-grab"),
        className,
      )}
    >
      <div className="relative" style={{ width: `${effective * 100}%` }}>
        {/* eslint-disable-next-line @next/next/no-img-element -- presigned storage URL */}
        <img ref={imgRef} src={url} alt={alt} draggable={false} className="block w-full" onLoad={() => setLoaded(true)} />
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
