"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";

import { FormMessage } from "@/components/auth/form-message";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getJson, postJson } from "@/lib/api-client";
import type { BookCopy, BookCopySummary } from "@/lib/books/copy";
import { plural } from "@/lib/format";
import { labelSchema } from "@/lib/validation";

type Props = {
  book: { id: string; name: string } | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/** A comma list ending in "and": "3 templates, 24 columns and 5 rules". */
function listOf(parts: string[]): string {
  return parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1) ?? ""}`;
}

/**
 * A new book from an existing one (docs/06 Phase 17): the setup travels, the work does not. The counts come
 * from the server before the button is offered, so the confirmation says exactly what the new book will hold.
 */
export function CopyBookDialog({ book, open, onOpenChange }: Props) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [summary, setSummary] = useState<BookCopySummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!open || !book) return;
    setName(`${book.name} (copy)`);
    setSummary(null);
    setError(null);
    let cancelled = false;
    void getJson<BookCopySummary>(`/api/books/${book.id}/copy`).then((result) => {
      if (cancelled) return;
      if (result.ok) setSummary(result.data);
      else setError(result.error.message);
    });
    return () => {
      cancelled = true;
    };
  }, [open, book]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!book) return;
    if (!labelSchema.safeParse(name).success) {
      setError("Give the new book a name (up to 200 characters).");
      return;
    }
    setError(null);
    setPending(true);
    const result = await postJson<BookCopy>(`/api/books/${book.id}/copy`, { name: name.trim() });
    if (!result.ok) {
      setPending(false);
      setError(result.error.message);
      return;
    }
    // `pending` stays true on success: the page is leaving, and a second click would create a second book.
    toast.success(`Created ${name.trim()} with ${plural(result.data.templates, "template")} and ${plural(result.data.columns, "column")}.`);
    router.push(`/books/${result.data.id}/templates`);
  }

  const carried = summary
    ? listOf([
        plural(summary.templates, "template"),
        plural(summary.columns, "column"),
        plural(summary.mappings, "mapping"),
        plural(summary.glossary, "glossary entry", "glossary entries"),
        plural(summary.rules, "validation rule"),
      ])
    : null;

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>New book from “{book?.name}”</DialogTitle>
            <DialogDescription>
              For the next round of the same paper: the new book is set up exactly like this one, and empty.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="copy-book-name">New book name</Label>
            <Input id="copy-book-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </div>
          <div className="bg-muted/50 flex flex-col gap-1 rounded-md px-3 py-2 text-sm" aria-live="polite">
            {carried ? (
              <>
                <p>Copies {carried}.</p>
                <p className="text-muted-foreground">
                  Documents, photos and rows are not copied, and “{book?.name}” is not changed.
                </p>
              </>
            ) : error ? null : (
              <p className="text-muted-foreground">Counting what will be copied…</p>
            )}
          </div>
          {error ? <FormMessage tone="error">{error}</FormMessage> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || summary === null}>
              {pending ? "Creating…" : "Create book"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
