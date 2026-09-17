"use client";

import { getJson } from "@/lib/api-client";
import type { PhotoView } from "@/lib/photos/views";

/**
 * Photo thumbnails for provenance chips, fetched on first hover and batched. Presigned URLs expire, so an
 * entry is refreshed after a while.
 */

type Entry = { url: string | null; at: number };

const TTL_MS = 10 * 60_000;
const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
const queued = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;

function notify() {
  for (const l of listeners) l();
}

async function flush() {
  timer = null;
  const ids = [...queued].slice(0, 200);
  for (const id of ids) queued.delete(id);
  if (ids.length === 0) return;
  const result = await getJson<PhotoView[]>(`/api/photos/status?ids=${ids.join(",")}`);
  // A failed request caches nothing, so the next hover tries again.
  if (result.ok) {
    const now = Date.now();
    const byId = new Map(result.data.map((p) => [p.id, p.thumbUrl]));
    for (const id of ids) entries.set(id, { url: byId.get(id) ?? null, at: now });
    notify();
  }
  if (queued.size > 0) timer = setTimeout(() => void flush(), 50);
}

export const thumbs = {
  load(photoId: string | null) {
    if (!photoId) return;
    const e = entries.get(photoId);
    if ((e && Date.now() - e.at < TTL_MS) || queued.has(photoId)) return;
    queued.add(photoId);
    timer ??= setTimeout(() => void flush(), 50);
  },
  get(photoId: string | null): string | null {
    return photoId ? (entries.get(photoId)?.url ?? null) : null;
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
