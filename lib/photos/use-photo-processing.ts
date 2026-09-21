"use client";

import { useEffect, useRef, useState } from "react";

import { getJson } from "@/lib/api-client";
import type { DocumentDetail } from "@/lib/documents/service";

import type { PhotoView } from "./views";

const POLL_MS = 2000;
/** `/api/photos/status` takes at most this many ids. */
export const STATUS_CHUNK = 200;

/** Photos still being processed, or edited and waiting for their new working copy (unless that failed). */
export function isPending(p: PhotoView): boolean {
  return (p.status !== "DONE" && p.status !== "FAILED") || (p.status === "DONE" && !p.workingUrl && !p.errorMessage);
}

export async function fetchDocumentDetails(ids: string[]): Promise<Map<string, DocumentDetail | null>> {
  const results = await Promise.all(ids.map((id) => getJson<DocumentDetail>(`/api/documents/${id}`)));
  return new Map(
    ids.map((id, i) => {
      const r = results[i];
      return [id, r?.ok ? r.data : null];
    }),
  );
}

/**
 * Polls processing state for every pending photo, every 2 s, until none is pending. `missing` are ids
 * the server no longer has: a PDF placeholder is replaced by its pages, so the caller reloads the
 * document it belonged to. Shared by the batch intake and the phone's upload screen (Phase 18).
 */
export function usePhotoProcessing(
  photos: Record<string, PhotoView>,
  onUpdate: (views: PhotoView[], missing: string[]) => Promise<void> | void,
): void {
  const onUpdateRef = useRef(onUpdate);
  useEffect(() => {
    onUpdateRef.current = onUpdate;
  });
  // Bumped after every poll so polling continues while the same photos stay pending.
  const [pollTick, setPollTick] = useState(0);
  const pendingKey = Object.values(photos)
    .filter(isPending)
    .map((p) => p.id)
    .join(",");
  useEffect(() => {
    if (!pendingKey) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const ids = pendingKey.split(",").slice(0, STATUS_CHUNK);
        const result = await getJson<PhotoView[]>(`/api/photos/status?ids=${ids.join(",")}`);
        if (!result.ok || cancelled) return;
        const seen = new Set(result.data.map((p) => p.id));
        await onUpdateRef.current(
          result.data,
          ids.filter((id) => !seen.has(id)),
        );
      } finally {
        // Re-arm even when nothing changed or the request failed; the effect re-runs on the new tick.
        if (!cancelled) setPollTick((n) => n + 1);
      }
    }, POLL_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [pendingKey, pollTick]);
}
