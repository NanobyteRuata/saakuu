"use client";

import { RotateCcw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { FormMessage } from "@/components/auth/form-message";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { getJson, postJson } from "@/lib/api-client";
import { RUN_STATE_LABELS } from "@/lib/documents/labels";
import { ACTIVE_RUN_STATES } from "@/lib/documents/schemas";
import type { PageActivity, PageRunState, RunActivityItem, RunActivityPage } from "@/lib/extraction/activity";
import type { StartResult } from "@/lib/extraction/service";
import { isoDate, plural } from "@/lib/format";
import { cn } from "@/lib/utils";

type Props = {
  bookId: string;
  open: boolean;
  /** Opened from a row: that document first, whatever the list order. */
  focusDocumentId: string | null;
  onOpenChange: (open: boolean) => void;
  onOpenDocument: (documentId: string) => void;
  /** A retry started a run: the list and the nav need to hear about it. */
  onRetried: () => void;
};

const POLL_MS = 2000;
const PAGE_LABELS: Record<PageRunState, string> = {
  NOT_READ: "Not read",
  QUEUED: "Waiting",
  RUNNING: "Reading",
  COMPLETE: "Read",
  FAILED: "Failed",
};

const isActive = (d: RunActivityItem) => ACTIVE_RUN_STATES.includes(d.runState);

/**
 * What the machine is doing (Phase 18, decision 75): a drawer on Documents, not a workspace. A queue
 * is plumbing operators have no model for, and splitting "start the run" from "see the run" would undo
 * Phase 9.1's finding that feedback belongs where the polling is. Per document and per page, with the
 * reason a page failed in the words the worker recorded, and retry where retrying can help.
 */
export function RunDrawer({ bookId, open, focusDocumentId, onOpenChange, onOpenDocument, onRetried }: Props) {
  const [items, setItems] = useState<RunActivityItem[] | null>(null);
  const [focused, setFocused] = useState<RunActivityItem | null>(null);
  const [summary, setSummary] = useState<RunActivityPage["summary"] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [failedLoads, setFailedLoads] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const loadedCount = useRef(0);

  /** Re-reads the list from the top, as far as it was scrolled, plus the focused document. */
  const load = useCallback(async () => {
    const limit = Math.min(200, Math.max(50, loadedCount.current));
    const [list, focus] = await Promise.all([
      getJson<RunActivityPage>(`/api/books/${bookId}/runs?limit=${limit}`),
      focusDocumentId ? getJson<RunActivityPage>(`/api/books/${bookId}/runs?documentId=${focusDocumentId}`) : null,
    ]);
    if (!list.ok) {
      setError(list.error.message);
      setFailedLoads((n) => n + 1);
      return;
    }
    setItems(list.data.items);
    setSummary(list.data.summary);
    setNextCursor(list.data.nextCursor);
    loadedCount.current = list.data.items.length;
    setFocused(focus?.ok ? (focus.data.items[0] ?? null) : null);
    setError(null);
    setFailedLoads(0);
  }, [bookId, focusDocumentId]);

  useEffect(() => {
    if (!open) return;
    setItems(null);
    setFocused(null);
    setError(null);
    loadedCount.current = 0;
    void load();
  }, [open, load]);

  const others = (items ?? []).filter((d) => d.documentId !== focused?.documentId);
  const anyActive = (items ?? []).some(isActive) || (focused !== null && isActive(focused));
  // Only while something is being read, backing off on failed polls like the document drawer does.
  useEffect(() => {
    if (!open || !anyActive) return;
    const t = window.setTimeout(async () => {
      await load();
      setTick((n) => n + 1);
    }, POLL_MS * Math.min(2 ** failedLoads, 15));
    return () => window.clearTimeout(t);
  }, [open, anyActive, load, failedLoads, tick]);

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    const result = await getJson<RunActivityPage>(`/api/books/${bookId}/runs?cursor=${encodeURIComponent(nextCursor)}`);
    setLoadingMore(false);
    if (!result.ok) {
      toast.error(result.error.message);
      return;
    }
    setItems((prev) => {
      const next = [...(prev ?? []), ...result.data.items];
      loadedCount.current = next.length;
      return next;
    });
    setNextCursor(result.data.nextCursor);
  }

  async function retry(key: string, body: { photoIds: string[] } | { documentIds: string[] }, what: string) {
    setRetrying(key);
    const result = await postJson<StartResult>("/api/extractions/retry", body);
    setRetrying(null);
    if (!result.ok) {
      toast.error(result.error.message);
      return;
    }
    const skipped = result.data.skipped[0];
    if (result.data.queued > 0) toast.success(`Retrying ${what}.`);
    else if (result.data.alreadyStarted > 0) toast.info("That retry has already started.");
    else if (skipped) toast.warning(skipped.reason);
    await load();
    onRetried();
  }

  const renderItem = (d: RunActivityItem, highlight: boolean) => (
    <RunItem
      key={d.documentId}
      item={d}
      highlight={highlight}
      retrying={retrying}
      onOpenDocument={() => onOpenDocument(d.documentId)}
      onRetryPage={(p) => void retry(p.photoId, { photoIds: [p.photoId] }, `page ${p.page}`)}
      onRetryDocument={(n) => void retry(d.documentId, { documentIds: [d.documentId] }, plural(n, "failed page"))}
    />
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Extraction runs</SheetTitle>
          <SheetDescription>
            {summary
              ? summary.active === 0 && summary.failed === 0
                ? "Nothing is being read, and nothing has failed."
                : [
                    summary.active > 0 ? `${plural(summary.active, "document")} being read` : null,
                    summary.failed > 0 ? `${plural(summary.failed, "document")} with failed pages` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")
              : "What the AI is reading, page by page."}
          </SheetDescription>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-6 py-4">
          {items === null ? (
            error ? (
              <div className="flex flex-col items-start gap-2">
                <FormMessage tone="error">{error}</FormMessage>
                <Button size="sm" variant="outline" onClick={() => void load()}>
                  Try again
                </Button>
              </div>
            ) : (
              <p className="text-muted-foreground text-sm">Loading runs…</p>
            )
          ) : (
            <>
              {focused ? renderItem(focused, true) : null}
              {others.map((d) => renderItem(d, false))}
              {focused === null && others.length === 0 ? (
                <p className="text-muted-foreground rounded-lg border border-dashed px-4 py-10 text-center text-sm">
                  Nothing has been read in the last day. Documents you extract show up here while they are read, and
                  stay for a day afterwards — or until you retry them, if any of their pages failed.
                </p>
              ) : null}
              {nextCursor ? (
                <Button variant="outline" size="sm" className="self-center" disabled={loadingMore} onClick={() => void loadMore()}>
                  {loadingMore ? "Loading…" : "Show more"}
                </Button>
              ) : null}
              {error ? <FormMessage tone="error">{error}</FormMessage> : null}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

type ItemProps = {
  item: RunActivityItem;
  highlight: boolean;
  retrying: string | null;
  onOpenDocument: () => void;
  onRetryPage: (page: PageActivity) => void;
  onRetryDocument: (failedPages: number) => void;
};

function RunItem({ item, highlight, retrying, onOpenDocument, onRetryPage, onRetryDocument }: ItemProps) {
  const done = item.pages.filter((p) => p.state === "COMPLETE" || p.state === "FAILED").length;
  const failed = item.pages.filter((p) => p.state === "FAILED");
  const retryable = failed.filter((p) => p.retryable);
  const active = isActive(item);
  return (
    <section
      aria-label={item.label ?? "Untitled document"}
      className={cn("flex flex-col gap-2 rounded-lg border p-3", highlight && "border-primary ring-primary/30 ring-2")}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col">
          <button type="button" className="truncate text-left font-medium hover:underline" onClick={onOpenDocument}>
            {item.label ?? "Untitled document"}
          </button>
          <span className="text-muted-foreground truncate text-xs">
            {item.templateName} · started {isoDate(item.lastRunAt)}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-muted-foreground text-xs tabular-nums">
            {active ? `${done} of ${plural(item.pages.length, "page")} read` : plural(item.pages.length, "page")}
          </span>
          <Badge variant={item.runState === "FAILED" || item.runState === "PARTIAL" ? "destructive" : active ? "default" : "outline"}>
            {RUN_STATE_LABELS[item.runState]}
          </Badge>
        </div>
      </div>

      <ol className="flex flex-wrap gap-1" aria-label="Pages">
        {item.pages.map((p) => (
          <li
            key={p.photoId}
            title={`Page ${p.page}: ${PAGE_LABELS[p.state]}`}
            className={cn(
              "flex h-6 min-w-6 items-center justify-center rounded border px-1 text-[11px] tabular-nums",
              p.state === "COMPLETE" && "bg-muted text-muted-foreground",
              p.state === "RUNNING" && "border-primary text-primary animate-pulse",
              p.state === "QUEUED" && "border-dashed",
              p.state === "FAILED" && "border-destructive bg-destructive/10 text-destructive font-medium",
              p.state === "NOT_READ" && "text-muted-foreground border-dashed opacity-60",
            )}
          >
            <span className="sr-only">
              Page {p.page}: {PAGE_LABELS[p.state]}
            </span>
            <span aria-hidden>{p.page}</span>
          </li>
        ))}
      </ol>

      {failed.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {failed.map((p) => (
            <li key={p.photoId} className="flex items-start justify-between gap-3 text-sm">
              <div className="flex min-w-0 flex-col">
                <span className="font-medium">Page {p.page} failed</span>
                {p.error ? <span className="text-destructive">{p.error}</span> : null}
              </div>
              {p.retryable ? (
                <Button size="sm" variant="outline" disabled={retrying !== null} onClick={() => onRetryPage(p)}>
                  <RotateCcw />
                  {retrying === p.photoId ? "Retrying…" : "Retry page"}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {retryable.length > 1 ? (
        <Button
          size="sm"
          variant="outline"
          className="self-start"
          disabled={retrying !== null}
          onClick={() => onRetryDocument(retryable.length)}
        >
          <RotateCcw />
          {retrying === item.documentId ? "Retrying…" : `Retry ${plural(retryable.length, "failed page")}`}
        </Button>
      ) : null}
    </section>
  );
}
