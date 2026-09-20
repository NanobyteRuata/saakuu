"use client";

import { useSyncExternalStore } from "react";

/**
 * The three layout targets (docs/05 §0, decision 69). Not responsive in the fluid sense: each width
 * gets a layout that is honest about what that device can do.
 *
 * - `narrow` (< 1280px): upload only. Standing at the filing cabinet with a phone is a real use;
 *   reading Burmese handwriting on one is not.
 * - `two` (1280–1599px): two panes.
 * - `three` (>= 1600px): three panes, or two with more density.
 */
export type LayoutTarget = "narrow" | "two" | "three";

export const TWO_PANE_MIN_PX = 1280;
export const THREE_PANE_MIN_PX = 1600;

const TWO_PANE = `(min-width: ${TWO_PANE_MIN_PX}px)`;
const THREE_PANE = `(min-width: ${THREE_PANE_MIN_PX}px)`;

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const lists = [window.matchMedia(TWO_PANE), window.matchMedia(THREE_PANE)];
  for (const list of lists) list.addEventListener("change", onChange);
  return () => {
    for (const list of lists) list.removeEventListener("change", onChange);
  };
}

function snapshot(): LayoutTarget {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "two";
  if (window.matchMedia(THREE_PANE).matches) return "three";
  return window.matchMedia(TWO_PANE).matches ? "two" : "narrow";
}

/**
 * The server cannot know the viewport, so it renders the two-pane layout and a narrow client
 * re-renders once after hydration. Desktop-first is the right way round here: every operator who
 * reviews is on a wide screen, and the alternative flashes the upload screen at all of them.
 *
 * This is a hook rather than a CSS breakpoint because the narrow layout must *unmount* the
 * workspace — a phone should never mount the virtualised output table, only hide it.
 */
export function useLayoutTarget(): LayoutTarget {
  return useSyncExternalStore(subscribe, snapshot, () => "two" as const);
}
