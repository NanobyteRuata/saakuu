import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing";

import { AppError } from "@/lib/errors";

import { compareSiblings, sameRef, type Sibling, type SiblingRef } from "./tree";

/** Position after the last sibling. */
export function appendPosition(siblings: { id: string; position: string }[]): string {
  return generateKeyBetween([...siblings].sort(compareSiblings).at(-1)?.position ?? null, null);
}

/**
 * Where `moving` lands when placed after `after` (null = first) among its new siblings, which may
 * be groups and fields mixed. Normally a single new key, so a move writes one row. If neighbouring
 * keys are equal (only possible after a collision), the whole sibling list is re-spaced and
 * returned in `rewrites`.
 */
export function positionAfter(
  siblings: Sibling[],
  after: SiblingRef | null,
  moving: SiblingRef,
): { position: string; rewrites: Sibling[] } {
  const list = siblings.filter((s) => !sameRef(s, moving)).sort(compareSiblings);
  let at = 0;
  if (after !== null) {
    if (sameRef(after, moving)) throw new AppError("VALIDATION", "An item can't be placed after itself.");
    const idx = list.findIndex((s) => sameRef(s, after));
    if (idx < 0) throw new AppError("VALIDATION", "The item you placed this next to has moved or been deleted. Reload and try again.");
    at = idx + 1;
  }
  const prev = list[at - 1]?.position ?? null;
  const next = list[at]?.position ?? null;
  if (prev === null || next === null || prev < next) {
    return { position: generateKeyBetween(prev, next), rewrites: [] };
  }

  const keys = generateNKeysBetween(null, null, list.length + 1);
  const ordered: SiblingRef[] = [...list.slice(0, at), moving, ...list.slice(at)];
  let position = "";
  const rewrites: Sibling[] = [];
  ordered.forEach((ref, i) => {
    const key = keys[i] ?? "";
    if (sameRef(ref, moving)) position = key;
    else rewrites.push({ kind: ref.kind, id: ref.id, position: key });
  });
  return { position, rewrites };
}
