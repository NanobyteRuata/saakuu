"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowRightLeft, Sparkles, Trash2, Upload } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { FormMessage } from "@/components/auth/form-message";
import { ExtractDialog } from "@/components/extraction/extract-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { getJson } from "@/lib/api-client";
import type { Page } from "@/lib/db/pagination";
import { CONTENT_STATE_LABELS, RUN_STATE_LABELS } from "@/lib/documents/labels";
import { RUN_STATES, type RunState } from "@/lib/documents/schemas";
import type { DocumentSummary } from "@/lib/documents/service";
import { MISMATCH_THRESHOLD } from "@/lib/extraction/schemas";
import type { ExtractionStatus } from "@/lib/extraction/service";
import { formatCount, isoDate, plural } from "@/lib/format";
import { DOCUMENT_FLAG_CHIPS } from "@/lib/transform/flags";
import { cn } from "@/lib/utils";

import { DeleteDocumentsDialog } from "./delete-documents-dialog";
import { DocumentDrawer } from "./document-drawer";
import { MoveDocumentsDialog } from "./move-documents-dialog";
import { UploadDialog, type TemplateOption } from "./upload-dialog";

export type { TemplateOption };

export type DocumentFilters = {
  templateId: string | null;
  runState: RunState | null;
  needsReview: boolean | null;
  hasEdits: boolean | null;
  reviewed: boolean | null;
  q: string;
};

type Props = {
  bookId: string;
  templates: TemplateOption[];
  filters: DocumentFilters;
  initialPage: Page<DocumentSummary>;
};

const ROW_HEIGHT = 64;
const ANY = "any";
const POLL_MS = 2000;

function isActive(state: RunState): boolean {
  return state === "QUEUED" || state === "RUNNING";
}
// Column tracks as [min rem, flexible max]. Header and rows share this, and the table's
// min-width is derived from it so columns never squeeze below their minimum.
const TRACKS: readonly (readonly [number, string?])[] = [
  [2], // select
  [3.5], // thumbnail
  [12, "2fr"], // label
  [8, "1fr"], // template
  [4], // pages
  [7], // run state
  [8], // content
  [4], // rows
  [6], // unreviewed
  [4], // errors
  [6], // last run
  [8], // model
];
const GAP_REM = 0.75; // gap-3
const PAD_X_REM = 0.75; // px-3
const GRID_STYLE = {
  gridTemplateColumns: TRACKS.map(([min, max]) => (max ? `minmax(${min}rem,${max})` : `${min}rem`)).join(" "),
};
const TABLE_MIN_WIDTH = `${TRACKS.reduce((sum, [min]) => sum + min, 0) + GAP_REM * (TRACKS.length - 1) + PAD_X_REM * 2}rem`;

function query(filters: DocumentFilters, cursor?: string): string {
  const params = new URLSearchParams();
  if (filters.templateId) params.set("templateId", filters.templateId);
  if (filters.runState) params.set("runState", filters.runState);
  if (filters.needsReview !== null) params.set("needsReview", String(filters.needsReview));
  if (filters.hasEdits !== null) params.set("hasEdits", String(filters.hasEdits));
  if (filters.reviewed !== null) params.set("reviewed", String(filters.reviewed));
  if (filters.q) params.set("q", filters.q);
  if (cursor) params.set("cursor", cursor);
  return params.toString();
}

function isFiltered(f: DocumentFilters): boolean {
  return f.templateId !== null || f.runState !== null || f.needsReview !== null || f.hasEdits !== null || f.reviewed !== null || f.q !== "";
}

/** Documents tab (docs/05 §8): filter bar, virtualised list, selection bar, detail drawer. */
export function DocumentsView({ bookId, templates, filters, initialPage }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const [items, setItems] = useState(initialPage.items);
  const [nextCursor, setNextCursor] = useState(initialPage.nextCursor);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [search, setSearch] = useState(filters.q);
  const [openId, setOpenId] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [extract, setExtract] = useState<{ verb: string; documentIds: string[] } | null>(null);
  const [progress, setProgress] = useState<Record<string, ExtractionStatus["pages"]>>({});
  const [pollTick, setPollTick] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Rows sit below the sticky header inside the same scroll element; the virtualizer needs that offset.
  const [headerHeight, setHeaderHeight] = useState(0);
  const headerRef = useCallback((el: HTMLDivElement | null) => {
    if (el) setHeaderHeight(el.offsetHeight);
  }, []);

  // Poll run state every 2 s while any loaded document is queued or running (docs/03 §7 → Progress).
  const activeKey = items.filter((d) => isActive(d.runState)).slice(0, 200).map((d) => d.id).join(",");
  useEffect(() => {
    if (!activeKey) return;
    const t = window.setTimeout(async () => {
      const result = await getJson<ExtractionStatus[]>(`/api/extractions/status?documentIds=${activeKey}`);
      if (result.ok) {
        const byId = new Map(result.data.map((s) => [s.id, s]));
        setItems((prev) =>
          prev.map((d) => {
            const s = byId.get(d.id);
            return s
              ? { ...d, runState: s.runState, contentState: s.contentState, needsReview: s.needsReview, templateMatchScore: s.templateMatchScore, lastRunAt: s.lastRunAt, lastModel: s.lastModel }
              : d;
          }),
        );
        setProgress((prev) => ({ ...prev, ...Object.fromEntries(result.data.map((s) => [s.id, s.pages])) }));
      }
      setPollTick((n) => n + 1);
    }, POLL_MS);
    return () => window.clearTimeout(t);
  }, [activeKey, pollTick]);

  const setFilters = useCallback(
    (patch: Partial<DocumentFilters>) => {
      const qs = query({ ...filters, ...patch });
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [filters, pathname, router],
  );

  useEffect(() => {
    if (search === filters.q) return;
    const t = window.setTimeout(() => setFilters({ q: search.trim() }), 350);
    return () => window.clearTimeout(t);
  }, [search, filters.q, setFilters]);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
    scrollMargin: headerHeight,
  });
  const virtualItems = virtualizer.getVirtualItems();
  const lastIndex = virtualItems.at(-1)?.index ?? 0;

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setLoadError(null);
    const result = await getJson<Page<DocumentSummary>>(`/api/books/${bookId}/documents?${query(filters, nextCursor)}`);
    setLoadingMore(false);
    if (!result.ok) {
      setLoadError(result.error.message);
      return;
    }
    setItems((prev) => [...prev, ...result.data.items]);
    setNextCursor(result.data.nextCursor);
  }, [bookId, filters, nextCursor, loadingMore]);

  useEffect(() => {
    if (nextCursor && !loadError && lastIndex >= items.length - 15) void loadMore();
  }, [lastIndex, items.length, nextCursor, loadError, loadMore]);

  /** Re-reads the list from the top (as many rows as are loaded, up to one full page) after a change. */
  const reloadList = useCallback(async () => {
    const limit = Math.min(200, Math.max(50, items.length));
    const result = await getJson<Page<DocumentSummary>>(`/api/books/${bookId}/documents?${query(filters)}&limit=${limit}`);
    if (!result.ok) {
      setLoadError(result.error.message);
      return;
    }
    setItems(result.data.items);
    setNextCursor(result.data.nextCursor);
    const live = new Set(result.data.items.map((d) => d.id));
    setSelected((prev) => new Set([...prev].filter((id) => live.has(id))));
  }, [bookId, filters, items.length]);

  function removeItems(ids: string[]) {
    const gone = new Set(ids);
    setItems((prev) => prev.filter((d) => !gone.has(d.id)));
    setSelected(new Set());
    router.refresh();
  }

  const selectedDocs = items.filter((d) => selected.has(d.id));
  const allSelected = items.length > 0 && selectedDocs.length === items.length;

  if (templates.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-16 text-center">
        <p className="font-medium">No documents yet</p>
        <p className="text-muted-foreground max-w-md text-sm">
          Documents are the photos of your paper forms, grouped so that each document is one record. Create a template
          first so SaaKuu knows what kind of paper you&apos;re uploading.
        </p>
        <Button asChild variant="outline">
          <Link href={`/books/${bookId}/templates`}>Go to templates</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Documents</h2>
        <Button size="sm" onClick={() => setUploadOpen(true)}>
          <Upload />
          Upload documents
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2" role="search" aria-label="Filter documents">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search labels"
          aria-label="Search document labels"
          className="w-56"
        />
        <Select value={filters.templateId ?? ANY} onValueChange={(v) => setFilters({ templateId: v === ANY ? null : v })}>
          <SelectTrigger className="w-48" aria-label="Template">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>All templates</SelectItem>
            {templates.map((t) => (
              <SelectItem key={t.id} value={t.id}>
                {t.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={filters.runState ?? ANY} onValueChange={(v) => setFilters({ runState: v === ANY ? null : (v as RunState) })}>
          <SelectTrigger className="w-40" aria-label="Run state">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>Any run state</SelectItem>
            {RUN_STATES.map((s) => (
              <SelectItem key={s} value={s}>
                {RUN_STATE_LABELS[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <TriState label="Needs review" value={filters.needsReview} onChange={(v) => setFilters({ needsReview: v })} />
        <TriState label="Has edits" value={filters.hasEdits} onChange={(v) => setFilters({ hasEdits: v })} />
        <TriState label="Reviewed" value={filters.reviewed} onChange={(v) => setFilters({ reviewed: v })} />
        {isFiltered(filters) ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setSearch("");
              router.replace(pathname, { scroll: false });
            }}
          >
            Clear filters
          </Button>
        ) : null}
      </div>

      {selected.size > 0 ? (
        <div role="region" aria-label="Selection" className="bg-muted flex flex-wrap items-center justify-between gap-3 rounded-lg px-4 py-2 text-sm">
          <span>{plural(selected.size, "document")} selected</span>
          <div className="flex flex-wrap gap-2">
            <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
              Clear selection
            </Button>
            <Button variant="outline" size="sm" onClick={() => setExtract({ verb: "Extract", documentIds: [...selected] })}>
              <Sparkles />
              Extract
            </Button>
            <Button variant="outline" size="sm" onClick={() => setExtract({ verb: "Re-extract", documentIds: [...selected] })}>
              Re-extract
            </Button>
            <Button variant="outline" size="sm" onClick={() => setMoveOpen(true)} disabled={templates.length < 2}>
              <ArrowRightLeft />
              Move to template
            </Button>
            <Button variant="destructive" size="sm" onClick={() => setDeleteOpen(true)}>
              <Trash2 />
              Delete ({selected.size})
            </Button>
          </div>
        </div>
      ) : null}

      {items.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-16 text-center">
          {isFiltered(filters) ? (
            <>
              <p className="font-medium">No documents match these filters</p>
              <p className="text-muted-foreground max-w-md text-sm">Clear a filter or change the search to see more documents.</p>
              <Button
                variant="outline"
                onClick={() => {
                  setSearch("");
                  setFilters({ q: "", templateId: null, runState: null, needsReview: null, hasEdits: null, reviewed: null });
                }}
              >
                Clear filters
              </Button>
            </>
          ) : (
            <>
              <p className="font-medium">No documents yet</p>
              <p className="text-muted-foreground max-w-md text-sm">
                Upload photos or PDFs of your paper forms to a template. Each photo becomes a document, and you can
                group the pages of a multi-page form into one.
              </p>
              <Button variant="outline" onClick={() => setUploadOpen(true)}>
                Upload your first documents
              </Button>
            </>
          )}
        </div>
      ) : (
        <div
          ref={scrollRef}
          className="max-h-[calc(100vh-22rem)] min-h-64 overflow-auto rounded-lg border"
          role="table"
          aria-label="Documents"
          aria-rowcount={items.length + 1}
        >
          <div style={{ minWidth: TABLE_MIN_WIDTH }}>
            <div
              ref={headerRef}
              className="text-muted-foreground bg-background sticky top-0 z-10 grid items-center gap-3 border-b px-3 py-2 text-xs"
              style={GRID_STYLE}
              role="row"
              aria-rowindex={1}
            >
              <span role="columnheader">
                <Checkbox
                  checked={allSelected ? true : selected.size > 0 ? "indeterminate" : false}
                  onCheckedChange={(c) => setSelected(c === true ? new Set(items.map((d) => d.id)) : new Set())}
                  aria-label="Select all loaded documents"
                />
              </span>
              {/* Wrapped: sr-only is position:absolute, which would drop it out of the grid and shift every header left. */}
              <span role="columnheader">
                <span className="sr-only">Thumbnail</span>
              </span>
              <span role="columnheader">Label</span>
              <span role="columnheader">Template</span>
              <span role="columnheader" className="text-right">Pages</span>
              <span role="columnheader">Run state</span>
              <span role="columnheader">Content</span>
              <span role="columnheader" className="text-right">Rows</span>
              <span role="columnheader" className="text-right">Unreviewed</span>
              <span role="columnheader" className="text-right">Errors</span>
              <span role="columnheader">Last run</span>
              <span role="columnheader">Model</span>
            </div>
            <div role="rowgroup">
              <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
                {virtualItems.map((v) => {
                  const d = items[v.index];
                  if (!d) return null;
                  const pages = progress[d.id];
                  return (
                    <div
                      key={d.id}
                      role="row"
                      aria-rowindex={v.index + 2}
                      className={cn(
                        "hover:bg-muted/40 absolute inset-x-0 grid cursor-pointer items-center gap-3 border-b px-3 text-sm",
                        selected.has(d.id) && "bg-primary/5",
                      )}
                      style={{ ...GRID_STYLE, height: ROW_HEIGHT, transform: `translateY(${v.start - headerHeight}px)` }}
                      onClick={() => setOpenId(d.id)}
                    >
                      <div role="cell" onClick={(e) => e.stopPropagation()}>
                        <Checkbox
                          checked={selected.has(d.id)}
                          onCheckedChange={(c) =>
                            setSelected((prev) => {
                              const next = new Set(prev);
                              if (c === true) next.add(d.id);
                              else next.delete(d.id);
                              return next;
                            })
                          }
                          aria-label={`Select ${d.label ?? "document"}`}
                        />
                      </div>
                      <div role="cell" className="bg-muted flex h-12 w-12 items-center justify-center overflow-hidden rounded border">
                        {d.thumbUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element -- presigned storage URL
                          <img src={d.thumbUrl} alt="" className="h-full w-full object-cover" loading="lazy" />
                        ) : (
                          <span className="text-muted-foreground text-[10px]">{d.failedPages > 0 ? "Failed" : "…"}</span>
                        )}
                      </div>
                      <div role="cell" className="flex min-w-0 flex-col gap-0.5">
                        <button
                          type="button"
                          className="truncate text-left font-medium hover:underline"
                          onClick={(e) => {
                            e.stopPropagation();
                            setOpenId(d.id);
                          }}
                        >
                          {d.label ?? "Untitled document"}
                        </button>
                        <DocumentFlags d={d} />
                      </div>
                      <span role="cell" className="truncate">{d.templateName}</span>
                      <span role="cell" className="text-right tabular-nums">{formatCount(d.pageCount)}</span>
                      <span role="cell" className="tabular-nums">
                        {RUN_STATE_LABELS[d.runState]}
                        {isActive(d.runState) && pages && pages.total > 1 ? ` ${pages.done}/${pages.total}` : ""}
                      </span>
                      <span role="cell">{CONTENT_STATE_LABELS[d.contentState]}</span>
                      <span role="cell" className="text-right tabular-nums">{formatCount(d.rowCount)}</span>
                      <span role="cell" className="text-right tabular-nums">{formatCount(d.unreviewedCells)}</span>
                      <span role="cell" className={cn("text-right tabular-nums", d.errorCells > 0 && "text-destructive font-medium")}>
                        {formatCount(d.errorCells)}
                      </span>
                      <span role="cell" className="tabular-nums">{d.lastRunAt ? isoDate(d.lastRunAt) : "—"}</span>
                      <span role="cell" className="truncate">{d.lastModel ?? "—"}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      <p className="text-muted-foreground text-sm" aria-live="polite">
        {loadingMore ? "Loading more documents…" : `${plural(items.length, "document")} loaded${nextCursor ? " — scroll for more" : ""}`}
      </p>
      {loadError ? (
        <div className="flex items-center gap-3">
          <FormMessage tone="error">{loadError}</FormMessage>
          <Button variant="outline" size="sm" onClick={() => void loadMore()}>
            Retry
          </Button>
        </div>
      ) : null}

      <DocumentDrawer
        documentId={openId}
        onOpenChange={(open) => !open && setOpenId(null)}
        onChanged={() => void reloadList()}
        onRemoved={(id) => {
          setOpenId(null);
          removeItems([id]);
        }}
      />
      <UploadDialog
        bookId={bookId}
        templates={templates}
        initialTemplateId={filters.templateId}
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        onClosed={() => {
          void reloadList();
          router.refresh();
        }}
      />
      <ExtractDialog
        target={extract ? { documentIds: extract.documentIds } : null}
        verb={extract?.verb}
        onOpenChange={(open) => !open && setExtract(null)}
        onStarted={() => {
          setSelected(new Set());
          void reloadList();
        }}
      />
      <DeleteDocumentsDialog open={deleteOpen} onOpenChange={setDeleteOpen} documentIds={[...selected]} onDeleted={removeItems} />
      <MoveDocumentsDialog
        open={moveOpen}
        onOpenChange={setMoveOpen}
        documentIds={[...selected]}
        templates={templates}
        onMoved={() => {
          setSelected(new Set());
          void reloadList();
          router.refresh();
        }}
      />
    </div>
  );
}

function TriState({ label, value, onChange }: { label: string; value: boolean | null; onChange: (v: boolean | null) => void }) {
  return (
    <Select value={value === null ? ANY : String(value)} onValueChange={(v) => onChange(v === ANY ? null : v === "true")}>
      <SelectTrigger className="w-40" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ANY}>{label}: any</SelectItem>
        <SelectItem value="true">{label}: yes</SelectItem>
        <SelectItem value="false">{label}: no</SelectItem>
      </SelectContent>
    </Select>
  );
}

function DocumentFlags({ d }: { d: DocumentSummary }) {
  const flags: { text: string; tone: "warn" | "error" | "info" }[] = [];
  if (d.processingPages > 0) flags.push({ text: `${plural(d.processingPages, "page")} processing`, tone: "info" });
  if (d.failedPages > 0) flags.push({ text: `${plural(d.failedPages, "page")} failed`, tone: "error" });
  if (d.templateMatchScore !== null && d.templateMatchScore < MISMATCH_THRESHOLD) flags.push({ text: "possible template mismatch", tone: "warn" });
  if (d.runState === "FAILED" || d.runState === "PARTIAL") flags.push({ text: "extraction failed, retry in details", tone: "error" });
  if (d.contentState === "NO_ROWS_FOUND") flags.push({ text: "no rows found", tone: "warn" });
  if (d.hasDisagreements) flags.push({ text: "has disagreements", tone: "warn" });
  for (const f of d.transformFlags) {
    if (f.kind !== "CELLS_FLAGGED") flags.push({ text: DOCUMENT_FLAG_CHIPS[f.kind], tone: "warn" });
  }
  if (d.needsReview) flags.push({ text: "needs review", tone: "warn" });
  if (d.reviewed) flags.push({ text: "✓ reviewed", tone: "info" });
  if (flags.length === 0) return null;
  return (
    <div className="flex gap-1 overflow-hidden">
      {flags.slice(0, 2).map((f) => (
        <Badge key={f.text} variant={f.tone === "error" ? "destructive" : "outline"} className="h-4 px-1.5 text-[10px] font-normal">
          {f.text}
        </Badge>
      ))}
    </div>
  );
}
