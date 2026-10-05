"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { FormMessage } from "@/components/auth/form-message";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { costLine, keyLine } from "@/lib/ai/cost-lines";
import { getJson, postJson } from "@/lib/api-client";
import type { Page } from "@/lib/db/pagination";
import type { DocumentsDeleteImpact, DocumentSummary } from "@/lib/documents/service";
import { isoDate, plural } from "@/lib/format";
import type { PromoteImpact, PromoteMode } from "@/lib/templates/specimens";

/**
 * The three ways a page crosses between a template's specimens and the book's documents (decision 78).
 * All of them copy or remove; none flips a flag, so the template always keeps its reference page and a
 * Test never re-reads real data.
 */

function newNonce(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}-nonce`;
}

const PICK_PAGE_SIZE = 20;

/** Choose an uploaded page of this template as a new specimen. The document itself is untouched. */
export function ChoosePageDialog({
  bookId,
  templateId,
  lang,
  open,
  onOpenChange,
  onChosen,
}: {
  bookId: string;
  templateId: string;
  lang: string | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChosen: (specimenId: string) => void;
}) {
  const [items, setItems] = useState<DocumentSummary[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [choosing, setChoosing] = useState<string | null>(null);
  // One click is one copy: a retry or a double click reuses this and finds the copy already made.
  const [nonce, setNonce] = useState("");

  async function loadPage(after: string | null) {
    const query = new URLSearchParams({ templateId, limit: String(PICK_PAGE_SIZE) });
    if (after) query.set("cursor", after);
    const result = await getJson<Page<DocumentSummary>>(`/api/books/${bookId}/documents?${query.toString()}`);
    if (!result.ok) {
      setError(result.error.message);
      setItems((prev) => prev ?? []);
      return;
    }
    setItems((prev) => [...(after ? (prev ?? []) : []), ...result.data.items]);
    setCursor(result.data.nextCursor);
  }

  useEffect(() => {
    if (!open) return;
    setItems(null);
    setError(null);
    setNonce(newNonce());
    void loadPage(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload only when the dialog opens
  }, [open, bookId, templateId]);

  async function choose(documentId: string) {
    setChoosing(documentId);
    setError(null);
    const result = await postJson<{ documentId: string }>(`/api/templates/${templateId}/specimens/from-document`, { documentId, nonce });
    setChoosing(null);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    toast.success("Copied to this template's specimens. Test on this page reads the copy on its own.");
    onOpenChange(false);
    onChosen(result.data.documentId);
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (choosing ? undefined : onOpenChange(next))}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Choose an uploaded page</DialogTitle>
          <DialogDescription>
            A copy of the page becomes a specimen of this template. The document stays exactly as it is, in your documents and
            your table. Test reads the copy again.
          </DialogDescription>
        </DialogHeader>
        {items === null ? (
          <p className="text-muted-foreground text-sm" aria-busy="true">
            Loading documents…
          </p>
        ) : items.length === 0 && !error ? (
          <p className="text-muted-foreground text-sm">This template has no uploaded documents yet. Upload a photo instead.</p>
        ) : (
          <ul className="max-h-96 divide-y overflow-y-auto rounded-md border text-sm" aria-label="Documents in this template">
            {items.map((doc) => (
              <li key={doc.id} className="flex items-center gap-3 px-3 py-2">
                {doc.thumbUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- presigned storage URL
                  <img src={doc.thumbUrl} alt="" className="size-10 shrink-0 rounded border object-cover" />
                ) : (
                  <div className="bg-muted size-10 shrink-0 rounded border" />
                )}
                <div className="min-w-0 flex-1">
                  <p lang={lang} className="font-value truncate">
                    {doc.label ?? "Untitled document"}
                  </p>
                  <p className="text-muted-foreground text-xs">
                    {plural(doc.pageCount, "page")}
                    {doc.processingPages > 0 ? ` · ${plural(doc.processingPages, "page")} still processing` : ""}
                    {doc.failedPages > 0 ? ` · ${plural(doc.failedPages, "page")} couldn't be processed` : ""}
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={choosing !== null || doc.processingPages > 0 || doc.failedPages > 0 || doc.pageCount === 0}
                  onClick={() => void choose(doc.id)}
                >
                  {choosing === doc.id ? "Copying…" : "Use this page"}
                </Button>
              </li>
            ))}
          </ul>
        )}
        {cursor ? (
          <Button type="button" variant="ghost" size="sm" className="self-start" onClick={() => void loadPage(cursor)}>
            Show more
          </Button>
        ) : null}
        {error ? <FormMessage tone="error">{error}</FormMessage> : null}
      </DialogContent>
    </Dialog>
  );
}

function promoteSentence(impact: PromoteImpact): string {
  switch (impact.mode) {
    case "with-reading":
      return `Adds a copy of this page to your documents, with this reading (${plural(impact.values, "value")}). Nothing is read again.`;
    case "read-again":
      return `Adds a copy of this page to your documents. It's read again there (${plural(impact.pages, "page")}), because ${impact.reason ?? "this test is out of date"}.`;
    case "unread":
      return `Adds a copy of this page to your documents, unread. ${impact.reason ?? "It can't be read right now."} Extract it from Documents later.`;
  }
}

const DONE_TOAST: Record<PromoteMode, (label: string) => string> = {
  "with-reading": (label) => `Added a copy of “${label}” to your documents with this reading.`,
  "read-again": (label) => `Added a copy of “${label}” to your documents. It's being read there.`,
  unread: (label) => `Added a copy of “${label}” to your documents, unread.`,
};

/**
 * The counted confirmation for adding a specimen to the documents. The server decides which case applies
 * and the confirm re-checks it, so the sentence the operator agreed to is always what happens.
 */
export function PromoteSpecimenDialog({
  bookId,
  specimen,
  open,
  onOpenChange,
  onPromoted,
}: {
  bookId: string;
  specimen: { id: string; label: string | null } | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPromoted: (mode: PromoteMode) => void;
}) {
  const [impact, setImpact] = useState<PromoteImpact | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [reload, setReload] = useState(0);
  const [nonce, setNonce] = useState("");
  const router = useRouter();
  const id = specimen?.id;

  useEffect(() => {
    if (!open || !id) return;
    let cancelled = false;
    setImpact(null);
    setError(null);
    setNonce(newNonce());
    void getJson<PromoteImpact>(`/api/documents/${id}/promote-impact`).then((result) => {
      if (cancelled) return;
      if (result.ok) setImpact(result.data);
      else setError(result.error.message);
    });
    return () => {
      cancelled = true;
    };
  }, [open, id, reload]);

  async function confirm() {
    if (!impact || !id) return;
    setPending(true);
    const result = await postJson<{ documentId: string; mode: PromoteMode }>(`/api/documents/${id}/promote`, {
      impactHash: impact.impactHash,
      nonce,
    });
    setPending(false);
    if (!result.ok) {
      setError(result.error.message);
      // What changed is shown in the counts, reloaded, rather than confirmed blind.
      if (result.error.code === "CONFLICT") setReload((n) => n + 1);
      return;
    }
    toast.success(DONE_TOAST[result.data.mode](specimen?.label ?? "this page"), {
      action: { label: "Documents", onClick: () => router.push(`/books/${bookId}/documents`) },
    });
    onOpenChange(false);
    onPromoted(result.data.mode);
  }

  return (
    <AlertDialog open={open} onOpenChange={(next) => (pending ? undefined : onOpenChange(next))}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Add “{specimen?.label ?? "this page"}” to your documents?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="flex flex-col gap-2">
              {impact ? (
                <>
                  <p>{promoteSentence(impact)}</p>
                  {impact.mode === "read-again" && impact.estimate ? (
                    <p>
                      {costLine(impact.estimate)} {keyLine(impact.estimate)}
                    </p>
                  ) : null}
                  <p>This specimen stays here for building the template.</p>
                  {impact.earlierCopies ? (
                    <p className="text-amber-700 dark:text-amber-400">
                      You already added this page to your documents on {isoDate(impact.earlierCopies.lastAt)} (
                      {plural(impact.earlierCopies.count, "copy", "copies")}). Adding it again puts its rows in the table twice.
                    </p>
                  ) : null}
                </>
              ) : error ? null : (
                <p>Checking this page&apos;s test…</p>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error ? <FormMessage tone="error">{error}</FormMessage> : null}
        <AlertDialogFooter>
          <AlertDialogCancel type="button" disabled={pending}>
            Cancel
          </AlertDialogCancel>
          <Button type="button" onClick={confirm} disabled={!impact || pending}>
            {pending ? "Adding…" : "Add to documents"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Removes a specimen. It lives only in the template, so this is where it is deleted (decision 78). */
export function RemoveSpecimenDialog({
  specimen,
  templateName,
  open,
  onOpenChange,
  onRemoved,
}: {
  specimen: { id: string; label: string | null; pages: number } | null;
  templateName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRemoved: () => void;
}) {
  const [impact, setImpact] = useState<DocumentsDeleteImpact | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const id = specimen?.id;

  useEffect(() => {
    if (!open || !id) return;
    let cancelled = false;
    setImpact(null);
    setError(null);
    void postJson<DocumentsDeleteImpact>("/api/documents/delete-impact", { ids: [id] }).then((result) => {
      if (cancelled) return;
      if (result.ok) setImpact(result.data);
      else setError(result.error.message);
    });
    return () => {
      cancelled = true;
    };
  }, [open, id]);

  async function confirm() {
    if (!impact || !id) return;
    setPending(true);
    const result = await postJson<{ deleted: number }>("/api/documents/delete", { ids: [id], impactHash: impact.impactHash, confirm: true });
    setPending(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    toast.success(`Removed “${specimen?.label ?? "the page"}” from this template's specimens.`);
    onOpenChange(false);
    onRemoved();
  }

  return (
    <AlertDialog open={open} onOpenChange={(next) => (pending ? undefined : onOpenChange(next))}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove this specimen?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="flex flex-col gap-2">
              <p>
                Removes this {specimen?.pages ?? 0}-page specimen and its test reading from “{templateName}”.
                Your documents aren&apos;t affected, including any copy of this page you added to them.
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error ? <FormMessage tone="error">{error}</FormMessage> : null}
        <AlertDialogFooter>
          <AlertDialogCancel type="button" disabled={pending}>
            Cancel
          </AlertDialogCancel>
          <Button type="button" variant="destructive" onClick={confirm} disabled={!impact || pending}>
            {pending ? "Removing…" : "Remove specimen"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
