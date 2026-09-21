"use client";

import { useCallback, useLayoutEffect, type ComponentProps, type ReactNode } from "react";
import { Group, Panel, Separator, useGroupRef, type Layout, type LayoutChangedMeta } from "react-resizable-panels";

import { cn } from "@/lib/utils";

/**
 * The pane primitive (docs/05 §0, decision 68). Panes are layout: a pane's size and collapsed state
 * never enter the URL, so deep links and the back button keep working.
 *
 * Sizes are remembered per workspace per user. `localStorage` can be empty, cleared or throw
 * (private windows, blocked site data), so every read is wrapped and the computed default renders on
 * its own — the same rule as the landing memory in `lib/books/landing-workspace.ts`.
 */
const key = (userId: string, workspace: string) => `saakuu.pane.${userId}.${workspace}`;

function readLayout(storageKey: string): Layout | null {
  try {
    const stored = window.localStorage.getItem(storageKey);
    if (stored === null) return null;
    const parsed: unknown = JSON.parse(stored);
    if (typeof parsed !== "object" || parsed === null) return null;
    const entries = Object.entries(parsed);
    // A hand-edited or half-written entry is no layout at all.
    if (entries.length === 0 || !entries.every(([, v]) => typeof v === "number" && Number.isFinite(v))) return null;
    return parsed as Layout;
  } catch {
    return null;
  }
}

function writeLayout(storageKey: string, layout: Layout): void {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(layout));
  } catch {
    // Remembering the split is a convenience; the default layout still works.
  }
}

type PaneGroupProps = Omit<ComponentProps<typeof Group>, "defaultLayout" | "onLayoutChanged" | "groupRef" | "id"> & {
  /** Workspace this layout belongs to, e.g. `review`. Combined with the user to form the key. */
  workspace: string;
  userId: string;
  children: ReactNode;
};

export function PaneGroup({ workspace, userId, className, children, ...rest }: PaneGroupProps) {
  const storageKey = key(userId, workspace);
  const groupRef = useGroupRef();

  /*
   * The remembered layout is applied after mount rather than passed as `defaultLayout`. The server
   * cannot read the browser's storage, so on the render the library latches there is no layout to
   * give it, and a `defaultLayout` that only becomes known during hydration is ignored. A layout
   * effect runs before paint, so the remembered split is still what the operator first sees, and
   * `setLayout` validates it against each pane's constraints — a stored layout that would squeeze
   * the photo below readable is clamped rather than honoured.
   */
  useLayoutEffect(() => {
    const stored = readLayout(storageKey);
    if (!stored) return;
    try {
      groupRef.current?.setLayout(stored);
    } catch {
      /*
       * A stored layout that no longer fits this group — saved when the workspace had a different
       * number of panes, or hand-edited — is thrown out rather than thrown. Workspaces key their
       * layouts per shape for exactly this reason; this is the net under that, because a remembered
       * split is a convenience and must never be able to take a workspace down with it.
       */
    }
  }, [storageKey, groupRef]);

  /*
   * Only a real drag or keyboard resize is worth remembering. The group also reports its layout on
   * mount and whenever constraints are recomputed, and persisting those would overwrite the
   * remembered split with the default before the effect above ever ran.
   */
  const onLayoutChanged = useCallback(
    (layout: Layout, meta: LayoutChangedMeta) => {
      if (meta.isUserInteraction) writeLayout(storageKey, layout);
    },
    [storageKey],
  );

  return (
    <Group
      id={storageKey}
      groupRef={groupRef}
      onLayoutChanged={onLayoutChanged}
      className={cn("min-h-0 flex-1", className)}
      {...rest}
    >
      {children}
    </Group>
  );
}

/**
 * ⚠️ Sizes are unit-sensitive: a bare **number is pixels** (`minSize={560}`), a bare **string is a
 * percentage** (`defaultSize="60"`). Say which you mean — `"60%"` and `560` — rather than relying on
 * the default reading.
 */
export function Pane({ className, ...rest }: ComponentProps<typeof Panel>) {
  return <Panel className={cn("flex min-h-0 min-w-0 flex-col", className)} {...rest} />;
}

/**
 * The drag handle. It stays a hairline so the photo keeps the pixels; the hit area is widened by the
 * group's own `resizeTargetMinimumSize`, not by making the line thicker. `orientation` is the
 * group's, so a horizontal group draws a vertical rule between its panes.
 *
 * The `title` is the only affordance a collapsed pane has: once a pane is dragged shut its handle
 * sits at the very edge of the group, and double-clicking is what brings it back.
 */
export function PaneHandle({
  className,
  orientation = "horizontal",
  "aria-label": ariaLabel = "Resize panes",
  title = "Drag to resize · double-click to reset",
  ...rest
}: ComponentProps<typeof Separator> & { orientation?: "horizontal" | "vertical" }) {
  return (
    <Separator
      aria-label={ariaLabel}
      title={title}
      className={cn(
        "bg-border hover:bg-ring focus-visible:outline-ring/50 transition-colors focus-visible:outline-2 focus-visible:outline-offset-0",
        "data-[separator=active]:bg-ring",
        orientation === "horizontal" ? "w-px cursor-col-resize" : "h-px cursor-row-resize",
        className,
      )}
      {...rest}
    />
  );
}
