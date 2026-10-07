import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing";

import { AppError } from "@/lib/errors";

import { compareSiblings } from "./field-list";

export type Positioned = { id: string; position: string };

/** Position after the last field. */
export function appendPosition(list: Positioned[]): string {
  return generateKeyBetween([...list].sort(compareSiblings).at(-1)?.position ?? null, null);
}

/**
 * Where the field `movingId` lands when placed after `afterId` (null = first) in the template's one
 * list. Normally a single new key, so a move writes one row. If neighbouring keys are equal (only
 * possible after a collision), the whole list is re-spaced and returned in `rewrites`.
 */
export function positionAfter(list: Positioned[], afterId: string | null, movingId: string): { position: string; rewrites: Positioned[] } {
  const others = list.filter((s) => s.id !== movingId).sort(compareSiblings);
  let at = 0;
  if (afterId !== null) {
    if (afterId === movingId) throw new AppError("VALIDATION", "A field can't be placed after itself.");
    const idx = others.findIndex((s) => s.id === afterId);
    if (idx < 0) throw new AppError("VALIDATION", "The field you placed this next to has moved or been deleted. Reload and try again.");
    at = idx + 1;
  }
  const prev = others[at - 1]?.position ?? null;
  const next = others[at]?.position ?? null;
  if (prev === null || next === null || prev < next) {
    return { position: generateKeyBetween(prev, next), rewrites: [] };
  }

  const keys = generateNKeysBetween(null, null, others.length + 1);
  const ordered = [...others.slice(0, at).map((s) => s.id), movingId, ...others.slice(at).map((s) => s.id)];
  let position = "";
  const rewrites: Positioned[] = [];
  ordered.forEach((id, i) => {
    const key = keys[i] ?? "";
    if (id === movingId) position = key;
    else rewrites.push({ id, position: key });
  });
  return { position, rewrites };
}
