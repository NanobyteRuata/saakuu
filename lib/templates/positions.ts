import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing";

import { sortByPosition } from "@/lib/books/column-ops";
import { AppError } from "@/lib/errors";

type Positioned = { id: string; position: string };

/** Position after the last sibling. */
export function appendPosition(siblings: Positioned[]): string {
  return generateKeyBetween(sortByPosition(siblings).at(-1)?.position ?? null, null);
}

/**
 * Where `movingId` lands when placed after `afterId` (null = first) among its new siblings.
 * Normally a single new key, so a move writes one row. If neighbouring keys are equal (only
 * possible after a collision), the whole sibling list is re-spaced and returned in `rewrites`.
 */
export function positionAfter(
  siblings: Positioned[],
  afterId: string | null,
  movingId: string,
): { position: string; rewrites: Positioned[] } {
  const list = sortByPosition(siblings.filter((s) => s.id !== movingId));
  let at = 0;
  if (afterId !== null) {
    if (afterId === movingId) throw new AppError("VALIDATION", "An item can't be placed after itself.");
    const idx = list.findIndex((s) => s.id === afterId);
    if (idx < 0) throw new AppError("VALIDATION", "The item you placed this next to has moved or been deleted. Reload and try again.");
    at = idx + 1;
  }
  const prev = list[at - 1]?.position ?? null;
  const next = list[at]?.position ?? null;
  if (prev === null || next === null || prev < next) {
    return { position: generateKeyBetween(prev, next), rewrites: [] };
  }

  const keys = generateNKeysBetween(null, null, list.length + 1);
  const ordered = [...list.slice(0, at).map((s) => s.id), movingId, ...list.slice(at).map((s) => s.id)];
  let position = "";
  const rewrites: Positioned[] = [];
  ordered.forEach((id, i) => {
    const key = keys[i] ?? "";
    if (id === movingId) position = key;
    else rewrites.push({ id, position: key });
  });
  return { position, rewrites };
}
