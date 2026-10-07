"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";

import { FormMessage } from "@/components/auth/form-message";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { getJson, postJson } from "@/lib/api-client";
import type { BookName } from "@/lib/books/service";
import type { Page } from "@/lib/db/pagination";
import { plural } from "@/lib/format";
import type { TemplateKind } from "@/lib/templates/schemas";
import type { DuplicateResult, TemplateCopySummary } from "@/lib/templates/service";
import { labelSchema, PAGE_LIMIT_MAX } from "@/lib/validation";

import { KindPicker } from "./kind-picker";

type Props = {
  bookId: string;
  template: { id: string; name: string; kind: TemplateKind } | null;
  /** Pre-selected type, e.g. the other kind when the user wanted to switch type. */
  initialKind?: TemplateKind;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

const THIS_BOOK = "this";

/**
 * Copies the source layer as a new template, optionally as the other type, and optionally into another book
 * (docs/06 Phase 17). The original is untouched. Into another book the mappings stay behind — they fill this
 * book's columns — and the confirmation says so with counts, alongside what does travel.
 */
export function DuplicateTemplateDialog({ bookId, template, initialKind, open, onOpenChange }: Props) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<TemplateKind>("FORM");
  const [includeMappings, setIncludeMappings] = useState(true);
  const [target, setTarget] = useState(THIS_BOOK);
  const [books, setBooks] = useState<{ id: string; name: string }[] | null>(null);
  const [summary, setSummary] = useState<TemplateCopySummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!open || !template) return;
    setName(`${template.name} (copy)`);
    setKind(initialKind ?? template.kind);
    setIncludeMappings(true);
    setTarget(THIS_BOOK);
    setSummary(null);
    setError(null);
    let cancelled = false;
    void getJson<TemplateCopySummary>(`/api/templates/${template.id}/duplicate`).then((result) => {
      if (cancelled) return;
      if (result.ok) setSummary(result.data);
      else setError(result.error.message);
    });
    void getJson<Page<BookName>>(`/api/books?view=names&limit=${PAGE_LIMIT_MAX}`).then((result) => {
      if (cancelled) return;
      // Without the list the copy still works inside this book, which is what the dialog did before.
      setBooks(result.ok ? result.data.items.filter((b) => b.id !== bookId) : []);
    });
    return () => {
      cancelled = true;
    };
  }, [open, template, initialKind, bookId]);

  const targetBook = target === THIS_BOOK ? null : (books?.find((b) => b.id === target) ?? null);

  function chooseTarget(next: string) {
    if (!template) return;
    setTarget(next);
    // Another book is the next round of the same paper, so it keeps its kind; the other-kind default is for
    // "switch Form ↔ Table", which only makes sense within this book.
    setKind(next === THIS_BOOK ? (initialKind ?? template.kind) : template.kind);
    // A book of its own needs no "(copy)" to tell the two apart; unless the name was already changed.
    if (name === `${template.name} (copy)` && next !== THIS_BOOK) setName(template.name);
    if (name === template.name && next === THIS_BOOK) setName(`${template.name} (copy)`);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!template) return;
    if (!labelSchema.safeParse(name).success) {
      setError("Give the copy a name (up to 200 characters).");
      return;
    }
    setPending(true);
    const result = await postJson<DuplicateResult>(`/api/templates/${template.id}/duplicate`, {
      name: name.trim(),
      kind,
      includeMappings: targetBook === null && includeMappings,
      ...(targetBook ? { targetBookId: targetBook.id } : {}),
    });
    setPending(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    onOpenChange(false);
    if (targetBook) toast.success(`Copied into ${targetBook.name}. Create columns from this template to finish.`);
    router.push(`/books/${result.data.bookId}/templates/${result.data.id}`);
  }

  const travels = summary ? plural(summary.fields, "field") : null;

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>Duplicate “{template?.name}”</DialogTitle>
            <DialogDescription>
              Copies the fields with their notes, anchors and instructions into a new template. Documents are not copied,
              and the original template is not changed.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="duplicate-target">Copy into</Label>
            <Select value={target} onValueChange={chooseTarget} disabled={pending || books === null}>
              <SelectTrigger id="duplicate-target" className="w-full">
                <SelectValue placeholder="This book" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={THIS_BOOK}>This book</SelectItem>
                {(books ?? []).map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="duplicate-name">New template name</Label>
            <Input id="duplicate-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <KindPicker value={kind} onChange={setKind} disabled={pending} />
          {targetBook === null ? (
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={includeMappings} onCheckedChange={(c) => setIncludeMappings(c === true)} disabled={pending} />
              Copy mappings to output columns too
            </label>
          ) : (
            <div className="bg-muted/50 flex flex-col gap-1 rounded-md px-3 py-2 text-sm" aria-live="polite">
              {summary ? (
                <>
                  <p>
                    Copies {travels} with every setting, note, anchor and instruction, as a draft in {targetBook.name}.
                  </p>
                  {summary.mappings > 0 ? (
                    <p className="text-muted-foreground">
                      {plural(summary.mappings, "mapping")} stay here: they fill this book&apos;s columns. In{" "}
                      {targetBook.name}, <span className="font-medium">Create columns from this template</span> finishes
                      the copy in one click.
                    </p>
                  ) : null}
                </>
              ) : (
                <p className="text-muted-foreground">Counting what will be copied…</p>
              )}
            </div>
          )}
          {error ? <FormMessage tone="error">{error}</FormMessage> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || (targetBook !== null && summary === null)}>
              {pending ? "Copying…" : targetBook ? `Copy into ${targetBook.name}` : "Duplicate template"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
