"use client";

import { Settings } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { getJson } from "@/lib/api-client";
import { writeLastWorkspace, type BookWorkspace } from "@/lib/books/landing-workspace";
import type { BookCounts } from "@/lib/books/service";
import { cn } from "@/lib/utils";

const POLL_MS = 2000;

const sameCounts = (a: BookCounts, b: BookCounts) =>
  a.documents === b.documents && a.rows === b.rows && a.unreviewedCells === b.unreviewedCells && a.runActive === b.runActive;

type Props = { bookId: string; userId: string; initialCounts: BookCounts };

/**
 * The four workspaces, in working order (docs/06 Phase 13). **The counts are the spine:** they turn a
 * flat bar into a sequence at almost no cost — an operator who sees `Review 412 left` does not need
 * to be told where to go next. Each count is part of its link's accessible name for the same reason.
 *
 * Settings is a gear rather than a peer (decision 68). Its route still works by URL.
 */
export function BookNav({ bookId, userId, initialCounts }: Props) {
  const pathname = usePathname();
  const root = `/books/${bookId}`;
  const [counts, setCounts] = useState(initialCounts);
  const [tick, setTick] = useState(0);
  const [stale, setStale] = useState(false);

  /*
   * The server is the authority whenever it sends different numbers: a `router.refresh()` after
   * starting an extraction is what flips `runActive` on and starts the polling below, and switching
   * books replaces these counts rather than showing the previous book's for a render.
   *
   * Compared by value, not by identity. The prop is a fresh object on every render of the server
   * layout, so keying off the reference would undo each poll as fast as it arrived.
   */
  const fromServer = useRef(initialCounts);
  useEffect(() => {
    if (sameCounts(fromServer.current, initialCounts)) return;
    fromServer.current = initialCounts;
    setCounts(initialCounts);
  }, [initialCounts]);

  // Navigation is a refresh too. The layout that supplied `initialCounts` is preserved across a
  // client navigation between workspaces, so its props alone would stay at their first-load values.
  const loadedFor = useRef(pathname);
  useEffect(() => {
    if (loadedFor.current === pathname) return;
    loadedFor.current = pathname;
    setStale(true);
  }, [pathname]);

  // Otherwise the counts only move while an extraction is in flight, so that is the only time this
  // polls. The last poll of a run carries `runActive: false` with the finished counts, which is what
  // makes the nav right after a run ends without a manual refresh. A chained timeout rather than an
  // interval, so a slow response cannot stack requests.
  useEffect(() => {
    if (!stale && !counts.runActive) return;
    const t = window.setTimeout(
      async () => {
        const result = await getJson<BookCounts>(`/api/books/${bookId}/counts`);
        // A failed poll keeps the last good counts and tries again on the next tick.
        if (result.ok) setCounts(result.data);
        setStale(false);
        setTick((n) => n + 1);
      },
      stale ? 0 : POLL_MS,
    );
    return () => window.clearTimeout(t);
  }, [bookId, stale, tick, counts.runActive]);

  const items: { label: string; count: string | null; segment: BookWorkspace; exact: boolean }[] = [
    { label: "Templates", count: null, segment: "templates", exact: false },
    { label: "Documents", count: counts.documents > 0 ? String(counts.documents) : null, segment: "documents", exact: false },
    { label: "Review", count: counts.unreviewedCells > 0 ? `${counts.unreviewedCells} left` : null, segment: "review", exact: true },
    { label: "Result Table", count: counts.rows > 0 ? `${counts.rows} rows` : null, segment: "", exact: true },
  ];

  return (
    <nav aria-label="Book workspaces" className="flex min-w-0 items-center gap-1">
      {items.map(({ label, count, segment, exact }) => {
        const href = segment ? `${root}/${segment}` : root;
        const active = exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={label}
            href={href}
            aria-current={active ? "page" : undefined}
            // Written before navigating, so landing on the Result Table by choice is not redirected away.
            onClick={() => writeLastWorkspace(userId, bookId, segment)}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm font-medium whitespace-nowrap transition-colors",
              active ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground hover:bg-muted/60",
            )}
          >
            {label}
            {count ? <span className={cn("text-xs tabular-nums", active ? "text-muted-foreground" : "opacity-70")}>{count}</span> : null}
          </Link>
        );
      })}
      <Link
        href={`${root}/settings`}
        aria-label="Settings"
        aria-current={pathname === `${root}/settings` ? "page" : undefined}
        className={cn(
          "ml-1 rounded-md p-1.5 transition-colors",
          pathname === `${root}/settings` ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground hover:bg-muted/60",
        )}
      >
        <Settings className="size-4" />
      </Link>
    </nav>
  );
}
