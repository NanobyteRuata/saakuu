"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import { Activity, ArrowRightLeft, Sparkles, Trash2, Upload } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { FormMessage } from "@/components/auth/form-message";
import { ExtractDialog, type ExtractTarget } from "@/components/extraction/extract-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { getJson } from "@/lib/api-client";
import type { Page } from "@/lib/db/pagination";
import { CONTENT_STATE_LABELS, RUN_STATE_LABELS } from "@/lib/documents/labels";
import type { DocumentSort, RunState } from "@/lib/documents/schemas";
import type { DocumentSummary, UploadDay } from "@/lib/documents/service";
import { DOCUMENT_STATUS_GROUPS, DOCUMENT_STATUS_LABELS, type DocumentStatus } from "@/lib/documents/status";
import { syncTimeZoneCookie } from "@/lib/documents/time-zone";
import { MISMATCH_THRESHOLD } from "@/lib/extraction/schemas";
import type { ExtractionStatus } from "@/lib/extraction/service";
import { formatCount, isoDate, plural } from "@/lib/format";
import { DOCUMENT_FLAG_CHIPS } from "@/lib/transform/flags";
import { cn } from "@/lib/utils";

import { DeleteDocumentsDialog } from "./delete-documents-dialog";
import { DocumentDrawer } from "./document-drawer";
import { MoveDocumentsDialog } from "./move-documents-dialog";
import { RunDrawer } from "./run-drawer";
import { TryOneDocument } from "./try-one-document";
import { UploadDialog, type TemplateOption } from "./upload-dialog";

export type { TemplateOption };

export type DocumentFilters = {
  templateId: string | null;
  status: DocumentStatus | null;
  /** `YYYY-MM-DD`, in the viewer's time zone. */
  uploadedOn: string | null;
  sort: DocumentSort;
  q: string;
};

type Props = {
  bookId: string;
  templates: TemplateOption[];
  filters: DocumentFilters;
  /** The zone the server filtered `uploadedOn` in; the client sends the same one. */
  timeZone: string;
  initialPage: Page<DocumentSummary>;
};

const SORT_LABELS: Record<DocumentSort, string> = {
  book: "Book order",
  newest: "Newest upload first",
  oldest: "Oldest upload first",
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
  [6], // uploaded
];
const GAP_REM = 0.75; // gap-3
const PAD_X_REM = 0.75; // px-3
const GRID_STYLE = {
  gridTemplateColumns: TRACKS.map(([min, max]) => (max ? `minmax(${min}rem,${max})` : `${min}rem`)).join(" "),
};
const TABLE_MIN_WIDTH = `${TRACKS.reduce((sum, [min]) => sum + min, 0) + GAP_REM * (TRACKS.length - 1) + PAD_X_REM * 2}rem`;

/** The page URL's query. The API gets the same plus `tz` (see `apiQuery`). */
function query(filters: DocumentFilters, cursor?: string): string {
  const params = new URLSearchParams();
  if (filters.templateId) params.set("templateId", filters.templateId);
  if (filters.status) params.set("status", filters.status);
  if (filters.uploadedOn) params.set("uploadedOn", filters.uploadedOn);
  if (filters.sort !== "book") params.set("sort", filters.sort);
  if (filters.q) params.set("q", filters.q);
  if (cursor) params.set("cursor", cursor);
  return params.toString();
}

/** Narrowing filters only: a sort shows the same documents. */
function isFiltered(f: DocumentFilters): boolean {
  return f.templateId !== null || f.status !== null || f.uploadedOn !== null || f.q !== "";
}

/** Arrived from a template card: the list is that template's documents and nothing else is narrowing it. */
function onlyTemplateFilter(f: DocumentFilters): boolean {
  return f.templateId !== null && f.status === null && f.uploadedOn === null && f.q === "";
}

/** Documents tab (docs/05 §8): filter bar, virtualised list, selection bar, detail drawer. */
export function DocumentsView({ bookId, templates, filters, timeZone, initialPage }: Props) {
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
  const [trying, setTrying] = useState(false);
  const [extract, setExtract] = useState<{ verb: string; target: ExtractTarget } | null>(null);
  // The run drawer (Phase 18): `null` closed; `focus` is the document a row opened it on.
  const [runs, setRuns] = useState<{ focus: string | null } | null>(null);
  const [uploadDays, setUploadDays] = useState<UploadDay[] | null>(null);
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
              ? {
                  ...d,
                  runState: s.runState,
                  contentState: s.contentState,
                  needsReview: s.needsReview,
                  templateMatchScore: s.templateMatchScore,
                  changedSinceLastRead: s.changedSinceLastRead,
                  lastRunAt: s.lastRunAt,
                  lastExtractedAt: s.lastExtractedAt,
                  lastModel: s.lastModel,
                }
              : d;
          }),
        );
        setProgress((prev) => ({ ...prev, ...Object.fromEntries(result.data.map((s) => [s.id, s.pages])) }));
      }
      setPollTick((n) => n + 1);
    }, POLL_MS);
    return () => window.clearTimeout(t);
  }, [activeKey, pollTick]);

  const apiQuery = useCallback(
    (cursor?: string) => {
      const qs = query(filters, cursor);
      return `${qs}${qs ? "&" : ""}tz=${encodeURIComponent(timeZone)}`;
    },
    [filters, timeZone],
  );

  // The server filtered by the cookie's zone. A first visit, or a laptop that crossed a border, has a
  // different one: store the browser's, and re-render if it changed what "uploaded on" means here.
  useEffect(() => {
    if (syncTimeZoneCookie(timeZone) && filters.uploadedOn) router.refresh();
  }, [timeZone, filters.uploadedOn, router]);

  const loadUploadDays = useCallback(async () => {
    const params = new URLSearchParams({ tz: timeZone });
    if (filters.templateId) params.set("templateId", filters.templateId);
    const result = await getJson<UploadDay[]>(`/api/books/${bookId}/documents/upload-days?${params.toString()}`);
    // Without the list the filter still shows the day it is set to; it just offers nothing else.
    if (result.ok) setUploadDays(result.data);
  }, [bookId, timeZone, filters.templateId]);

  useEffect(() => {
    void loadUploadDays();
  }, [loadUploadDays]);

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
    const result = await getJson<Page<DocumentSummary>>(`/api/books/${bookId}/documents?${apiQuery(nextCursor)}`);
    setLoadingMore(false);
    if (!result.ok) {
      setLoadError(result.error.message);
      return;
    }
    setItems((prev) => [...prev, ...result.data.items]);
    setNextCursor(result.data.nextCursor);
  }, [bookId, apiQuery, nextCursor, loadingMore]);

  useEffect(() => {
    if (nextCursor && !loadError && lastIndex >= items.length - 15) void loadMore();
  }, [lastIndex, items.length, nextCursor, loadError, loadMore]);

  /** Re-reads the list from the top (as many rows as are loaded, up to one full page) after a change. */
  const reloadList = useCallback(async () => {
    const limit = Math.min(200, Math.max(50, items.length));
    const result = await getJson<Page<DocumentSummary>>(`/api/books/${bookId}/documents?${apiQuery()}&limit=${limit}`);
    if (!result.ok) {
      setLoadError(result.error.message);
      return;
    }
    setItems(result.data.items);
    setNextCursor(result.data.nextCursor);
    const live = new Set(result.data.items.map((d) => d.id));
    setSelected((prev) => new Set([...prev].filter((id) => live.has(id))));
  }, [bookId, apiQuery, items.length]);

  function removeItems(ids: string[]) {
    const gone = new Set(ids);
    setItems((prev) => prev.filter((d) => !gone.has(d.id)));
    setSelected(new Set());
    router.refresh();
  }

  const selectedDocs = items.filter((d) => selected.has(d.id));
  const allSelected = items.length > 0 && selectedDocs.length === items.length;
  // null when no template filter is set, and for a book past MAX_TEMPLATES whose filter points beyond the loaded page:
  // the template-wide extract and the per-template empty state then fall back to the generic ones.
  const filterTemplate = templates.find((t) => t.id === filters.templateId) ?? null;
  const anyActive = activeKey !== "";
  // The day the list is filtered to stays offered even when the days list failed or has moved on.
  const dayOptions =
    filters.uploadedOn && !uploadDays?.some((d) => d.day === filters.uploadedOn)
      ? [{ day: filters.uploadedOn, count: null }, ...(uploadDays ?? [])]
      : (uploadDays ?? []);

  if (templates.length === 0) {
    return (
      <div className="m-auto flex max-w-lg flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-16 text-center">
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
    <div className="flex min-h-0 flex-1 flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Documents</h2>
        <div className="flex flex-wrap items-center gap-2">
          {onlyTemplateFilter(filters) && filterTemplate && selected.size === 0 ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setExtract({ verb: "Extract", target: { templateId: filterTemplate.id } })}
            >
              <Sparkles />
              <span className="max-w-64 truncate">Extract all in {filterTemplate.name}</span>
            </Button>
          ) : null}
          <Button variant="outline" size="sm" onClick={() => setRuns({ focus: null })}>
            <Activity className={cn(anyActive && "text-primary animate-pulse")} />
            {anyActive ? "Runs · reading" : "Runs"}
          </Button>
          <Button size="sm" onClick={() => setUploadOpen(true)}>
            <Upload />
            Upload documents
          </Button>
        </div>
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
        <Select value={filters.status ?? ANY} onValueChange={(v) => setFilters({ status: v === ANY ? null : (v as DocumentStatus) })}>
          <SelectTrigger className="w-56" aria-label="Status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>Any status</SelectItem>
            {DOCUMENT_STATUS_GROUPS.map((g) => (
              <SelectGroup key={g.label}>
                <SelectLabel>{g.label}</SelectLabel>
                {g.statuses.map((s) => (
                  <SelectItem key={s} value={s}>
                    {DOCUMENT_STATUS_LABELS[s]}
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
        <Select value={filters.uploadedOn ?? ANY} onValueChange={(v) => setFilters({ uploadedOn: v === ANY ? null : v })}>
          <SelectTrigger className="w-64" aria-label="Uploaded">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>Uploaded any day</SelectItem>
            {dayOptions.map((d) => (
              <SelectItem key={d.day} value={d.day}>
                <span className="tabular-nums">Uploaded {d.day}</span>
                {d.count !== null ? <span className="text-muted-foreground"> · {plural(d.count, "document")}</span> : null}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={filters.sort} onValueChange={(v) => setFilters({ sort: v as DocumentSort })}>
          <SelectTrigger className="w-48" aria-label="Sort">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(SORT_LABELS) as DocumentSort[]).map((s) => (
              <SelectItem key={s} value={s}>
                {SORT_LABELS[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
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
            <Button variant="outline" size="sm" onClick={() => setExtract({ verb: "Extract", target: { documentIds: [...selected] } })}>
              <Sparkles />
              Extract
            </Button>
            <Button variant="outline" size="sm" onClick={() => setExtract({ verb: "Re-extract", target: { documentIds: [...selected] } })}>
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
        <div className="m-auto flex max-w-lg flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-16 text-center">
          {onlyTemplateFilter(filters) && filterTemplate ? (
            <>
              <p className="font-medium">No documents in {filterTemplate.name}</p>
              <p className="text-muted-foreground max-w-md text-sm">
                This template has no documents yet. Upload photos or PDFs of its paper form to get started.
              </p>
              <div className="flex flex-wrap items-center justify-center gap-2">
                <Button variant="outline" onClick={() => setUploadOpen(true)}>
                  <Upload />
                  Upload documents
                </Button>
                <Button variant="outline" onClick={() => setTrying(true)}>
                  <Sparkles />
                  Try one document
                </Button>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setFilters({ templateId: null })}>
                Show all documents
              </Button>
            </>
          ) : isFiltered(filters) ? (
            <>
              <p className="font-medium">No documents match these filters</p>
              <p className="text-muted-foreground max-w-md text-sm">Clear a filter or change the search to see more documents.</p>
              <Button
                variant="outline"
                onClick={() => {
                  setSearch("");
                  setFilters({ q: "", templateId: null, status: null, uploadedOn: null });
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
          className="min-h-0 flex-1 overflow-auto rounded-lg border"
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
              <span role="columnheader">Uploaded</span>
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
                        <DocumentFlags d={d} onOpenRuns={() => setRuns({ focus: d.id })} />
                      </div>
                      <span role="cell" className="truncate">{d.templateName}</span>
                      <span role="cell" className="text-right tabular-nums">{formatCount(d.pageCount)}</span>
                      <span role="cell" className="tabular-nums">
                        {isActive(d.runState) ? (
                          // A running row opens the run drawer on itself: per page, with what failed and why.
                          <button
                            type="button"
                            className="text-primary hover:underline"
                            aria-label={`Watch ${d.label ?? "this document"} being read`}
                            onClick={(e) => {
                              e.stopPropagation();
                              setRuns({ focus: d.id });
                            }}
                          >
                            {RUN_STATE_LABELS[d.runState]}
                            {pages && pages.total > 1 ? ` ${pages.done}/${pages.total}` : ""}
                          </button>
                        ) : (
                          RUN_STATE_LABELS[d.runState]
                        )}
                      </span>
                      <span role="cell">{CONTENT_STATE_LABELS[d.contentState]}</span>
                      <span role="cell" className="text-right tabular-nums">{formatCount(d.rowCount)}</span>
                      <span role="cell" className="text-right tabular-nums">{formatCount(d.unreviewedCells)}</span>
                      <span role="cell" className={cn("text-right tabular-nums", d.errorCells > 0 && "text-destructive font-medium")}>
                        {formatCount(d.errorCells)}
                      </span>
                      <span role="cell" className="tabular-nums">{d.lastRunAt ? isoDate(d.lastRunAt) : "—"}</span>
                      <span role="cell" className="truncate">{d.lastModel ?? "—"}</span>
                      <span role="cell" className="tabular-nums">{isoDate(d.createdAt)}</span>
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
      {filterTemplate ? (
        <TryOneDocument
          bookId={bookId}
          templateId={filterTemplate.id}
          templateName={filterTemplate.name}
          lang={undefined}
          open={trying}
          onOpenChange={setTrying}
          onExtracted={() => {
            void reloadList();
            router.refresh();
          }}
        />
      ) : null}
      <UploadDialog
        bookId={bookId}
        templates={templates}
        initialTemplateId={filters.templateId}
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        onClosed={() => {
          void reloadList();
          void loadUploadDays();
          router.refresh();
        }}
      />
      <RunDrawer
        bookId={bookId}
        open={runs !== null}
        focusDocumentId={runs?.focus ?? null}
        onOpenChange={(open) => !open && setRuns(null)}
        onOpenDocument={(id) => {
          setRuns(null);
          setOpenId(id);
        }}
        onRetried={() => {
          void reloadList();
          // Starts the nav's polling, as any action that starts a run must (docs/05 §0).
          router.refresh();
        }}
      />
      <ExtractDialog
        target={extract?.target ?? null}
        verb={extract?.verb}
        onOpenChange={(open) => !open && setExtract(null)}
        onStarted={() => {
          setSelected(new Set());
          void reloadList();
          // The workspace nav's counts come from the server layout, so a run that has just started
          // is invisible to it until the route re-renders (docs/06 Phase 13).
          router.refresh();
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

function DocumentFlags({ d, onOpenRuns }: { d: DocumentSummary; onOpenRuns: () => void }) {
  const flags: { text: string; tone: "warn" | "error" | "info"; onClick?: () => void }[] = [];
  if (d.processingPages > 0) flags.push({ text: `${plural(d.processingPages, "page")} processing`, tone: "info" });
  if (d.failedPages > 0) flags.push({ text: `${plural(d.failedPages, "page")} failed`, tone: "error" });
  // High on purpose: only the first two chips are shown, and this is the one with an action behind it.
  if (d.changedSinceLastRead) flags.push({ text: "changed since last read", tone: "warn" });
  /*
   * Below that chip deliberately (Phase 15). A specimen explains every other number on the row — it
   * is out of the table, the export and the template's count until it is promoted in its drawer
   * (decision 71) — but only two chips render, and `changed since last read` is the one that has
   * something to do about it.
   */
  if (d.isSpecimen) flags.push({ text: "specimen", tone: "info" });
  if (d.templateMatchScore !== null && d.templateMatchScore < MISMATCH_THRESHOLD) flags.push({ text: "possible template mismatch", tone: "warn" });
  if (d.runState === "FAILED" || d.runState === "PARTIAL") flags.push({ text: "extraction failed, retry in runs", tone: "error", onClick: onOpenRuns });
  if (d.contentState === "NO_ROWS_FOUND") flags.push({ text: "no rows found", tone: "warn" });
  if (d.hasDisagreements) flags.push({ text: "has disagreements", tone: "warn" });
  for (const f of d.transformFlags) {
    if (f.kind !== "CELLS_FLAGGED") flags.push({ text: DOCUMENT_FLAG_CHIPS[f.kind], tone: "warn" });
  }
  // Named as the Status filter names it, so the chip and the filter that finds it read the same.
  if (d.needsReview) flags.push({ text: "flagged", tone: "warn" });
  if (d.reviewed) flags.push({ text: "✓ reviewed", tone: "info" });
  if (flags.length === 0) return null;
  return (
    <div className="flex gap-1 overflow-hidden">
      {flags.slice(0, 2).map((f) => {
        const badge = (
          <Badge key={f.text} variant={f.tone === "error" ? "destructive" : "outline"} className="h-4 px-1.5 text-[10px] font-normal">
            {f.text}
          </Badge>
        );
        const { onClick } = f;
        return onClick ? (
          <button
            key={f.text}
            type="button"
            className="hover:opacity-80"
            onClick={(e) => {
              e.stopPropagation();
              onClick();
            }}
          >
            {badge}
          </button>
        ) : (
          badge
        );
      })}
    </div>
  );
}
