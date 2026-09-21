"use client";

import { Copy, Pencil, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { FormMessage } from "@/components/auth/form-message";
import { Button } from "@/components/ui/button";
import { getJson } from "@/lib/api-client";
import type { Page } from "@/lib/db/pagination";
import { plural } from "@/lib/format";
import type { TemplateSummary } from "@/lib/templates/service";

import { ConfigBadge, KindBadge, RunBadge } from "./badges";
import { CreateTemplateDialog } from "./create-template-dialog";
import { DeleteTemplateDialog } from "./delete-template-dialog";
import { DuplicateTemplateDialog } from "./duplicate-template-dialog";

export function TemplateList({ bookId, initialPage }: { bookId: string; initialPage: Page<TemplateSummary> }) {
  const router = useRouter();
  const [templates, setTemplates] = useState(initialPage.items);
  const [nextCursor, setNextCursor] = useState(initialPage.nextCursor);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [toDuplicate, setToDuplicate] = useState<TemplateSummary | null>(null);
  const [toDelete, setToDelete] = useState<TemplateSummary | null>(null);

  // A refresh brings new counts and run badges for the first page; keep templates loaded further down.
  useEffect(() => {
    const fresh = new Map(initialPage.items.map((t) => [t.id, t]));
    setTemplates((prev) => {
      const known = new Set(prev.map((t) => t.id));
      return [...prev.map((t) => fresh.get(t.id) ?? t), ...initialPage.items.filter((t) => !known.has(t.id))];
    });
  }, [initialPage]);

  const running = templates.some((t) => t.run.state === "RUNNING");
  useEffect(() => {
    if (!running) return;
    const timer = window.setTimeout(() => router.refresh(), 2000);
    return () => window.clearTimeout(timer);
  }, [running, initialPage, router]);

  async function loadMore() {
    if (!nextCursor) return;
    setLoadingMore(true);
    setLoadError(null);
    const result = await getJson<Page<TemplateSummary>>(`/api/books/${bookId}/templates?cursor=${encodeURIComponent(nextCursor)}`);
    setLoadingMore(false);
    if (!result.ok) {
      setLoadError(result.error.message);
      return;
    }
    setTemplates((prev) => [...prev, ...result.data.items]);
    setNextCursor(result.data.nextCursor);
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-lg font-semibold">Templates</h2>
        {templates.length > 0 ? <CreateTemplateDialog bookId={bookId} /> : null}
      </div>

      {templates.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-16 text-center">
          <p className="font-medium">No templates yet</p>
          <p className="text-muted-foreground max-w-md text-sm">
            A template describes one kind of paper document: the fields to read from it, written the way they appear on
            the paper. Create one for each kind of form or table you photograph.
          </p>
          <CreateTemplateDialog bookId={bookId} label="Create your first template" />
        </div>
      ) : (
        <ul className="flex flex-col gap-3" aria-label="Templates">
          {templates.map((t) => (
            <li key={t.id} className="flex items-start justify-between gap-4 rounded-xl border p-4">
              <div className="flex min-w-0 flex-col gap-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <Link href={`/books/${bookId}/templates/${t.id}`} className="font-medium hover:underline">
                    {t.name}
                  </Link>
                  <KindBadge kind={t.kind} />
                  <ConfigBadge state={t.configState} />
                  <RunBadge run={t.run} />
                </div>
                <p className="text-muted-foreground text-sm">
                  {plural(t.fieldCount, "field")} ·{" "}
                  <Link
                    href={`/books/${bookId}/documents?templateId=${t.id}`}
                    className="text-foreground underline decoration-dotted underline-offset-4 hover:decoration-solid"
                  >
                    {plural(t.documentCount, "document")}
                  </Link>{" "}
                  · {plural(t.photoCount, "photo")}
                  {/* Counted apart, so the document count stays the number of pages with work in them. */}
                  {t.specimenCount > 0 ? ` · ${t.specimenCount} specimen` : ""}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button asChild variant="ghost" size="icon" aria-label={`Edit ${t.name}`}>
                  <Link href={`/books/${bookId}/templates/${t.id}`}>
                    <Pencil />
                  </Link>
                </Button>
                <Button variant="ghost" size="icon" aria-label={`Duplicate ${t.name}`} onClick={() => setToDuplicate(t)}>
                  <Copy />
                </Button>
                <Button variant="ghost" size="icon" aria-label={`Delete ${t.name}`} onClick={() => setToDelete(t)}>
                  <Trash2 />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {loadError ? <FormMessage tone="error">{loadError}</FormMessage> : null}
      {nextCursor ? (
        <Button variant="outline" className="self-center" onClick={loadMore} disabled={loadingMore}>
          {loadingMore ? "Loading…" : "Load more templates"}
        </Button>
      ) : null}

      <DuplicateTemplateDialog
        bookId={bookId}
        template={toDuplicate}
        open={toDuplicate !== null}
        onOpenChange={(open) => !open && setToDuplicate(null)}
      />
      <DeleteTemplateDialog
        template={toDelete}
        open={toDelete !== null}
        onOpenChange={(open) => !open && setToDelete(null)}
        onDeleted={(id) => {
          setTemplates((prev) => prev.filter((t) => t.id !== id));
          router.refresh();
        }}
      />
    </div>
  );
}
