"use client";

import { Pencil, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { deleteJson, getJson, patchJson, postJson } from "@/lib/api-client";
import type { GlossaryEntryView } from "@/lib/books/glossary-service";
import { glossaryEntryInputSchema } from "@/lib/books/schemas";
import type { Page } from "@/lib/db/pagination";

function firstProblem(input: unknown): string | null {
  const parsed = glossaryEntryInputSchema.safeParse(input);
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? "Check the term and meaning.");
}

export function GlossaryEditor({ bookId, initial }: { bookId: string; initial: Page<GlossaryEntryView> }) {
  const base = `/api/books/${bookId}/glossary`;
  const [entries, setEntries] = useState(initial.items);
  const [nextCursor, setNextCursor] = useState(initial.nextCursor);
  const [term, setTerm] = useState("");
  const [meaning, setMeaning] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState({ term: "", meaning: "" });
  const [rowError, setRowError] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<GlossaryEntryView | null>(null);
  const [busy, setBusy] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  async function add(e: FormEvent) {
    e.preventDefault();
    const problem = firstProblem({ term, meaning });
    if (problem) {
      setAddError(problem);
      return;
    }
    setBusy(true);
    const result = await postJson<GlossaryEntryView>(base, { term, meaning });
    setBusy(false);
    if (!result.ok) {
      setAddError(result.error.message);
      return;
    }
    setAddError(null);
    setEntries((prev) => [...prev, result.data]);
    setTerm("");
    setMeaning("");
  }

  async function saveEdit(id: string) {
    const problem = firstProblem(draft);
    if (problem) {
      setRowError(problem);
      return;
    }
    setBusy(true);
    const result = await patchJson<GlossaryEntryView>(`${base}/${id}`, draft);
    setBusy(false);
    if (!result.ok) {
      setRowError(result.error.message);
      return;
    }
    setEntries((prev) => prev.map((entry) => (entry.id === id ? result.data : entry)));
    setEditingId(null);
    setRowError(null);
  }

  async function confirmDelete() {
    if (!toDelete) return;
    setBusy(true);
    const result = await deleteJson<{ deleted: true }>(`${base}/${toDelete.id}`);
    setBusy(false);
    if (!result.ok) {
      setListError(result.error.message);
      setToDelete(null);
      return;
    }
    const goneId = toDelete.id;
    setEntries((prev) => prev.filter((entry) => entry.id !== goneId));
    setToDelete(null);
    toast.success("Glossary entry deleted.");
  }

  async function loadMore() {
    if (!nextCursor) return;
    setBusy(true);
    const result = await getJson<Page<GlossaryEntryView>>(`${base}?cursor=${encodeURIComponent(nextCursor)}`);
    setBusy(false);
    if (!result.ok) {
      setListError(result.error.message);
      return;
    }
    setEntries((prev) => [...prev, ...result.data.items]);
    setNextCursor(result.data.nextCursor);
  }

  return (
    <div className="flex flex-col gap-4">
      {entries.length === 0 ? (
        <p className="text-muted-foreground rounded-lg border border-dashed px-4 py-6 text-sm">
          No glossary entries yet. Add the conventions your forms use, such as &ldquo;1 1/2 means 1 year and 6
          months&rdquo; or &ldquo;a dash means not applicable&rdquo;, and the AI will be told about them on every
          extraction.
        </p>
      ) : (
        <ul className="divide-y rounded-lg border" aria-label="Glossary entries">
          {entries.map((entry) =>
            editingId === entry.id ? (
              <li key={entry.id} className="flex flex-col gap-2 p-3">
                <Input
                  aria-label="Edit term"
                  className="font-value"
                  value={draft.term}
                  onChange={(e) => setDraft((d) => ({ ...d, term: e.target.value }))}
                />
                <Textarea
                  aria-label="Edit meaning"
                  value={draft.meaning}
                  onChange={(e) => setDraft((d) => ({ ...d, meaning: e.target.value }))}
                />
                {rowError ? <FormMessage tone="error">{rowError}</FormMessage> : null}
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => saveEdit(entry.id)} disabled={busy}>
                    Save entry
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setEditingId(null);
                      setRowError(null);
                    }}
                    disabled={busy}
                  >
                    Cancel
                  </Button>
                </div>
              </li>
            ) : (
              <li key={entry.id} className="flex items-start gap-3 p-3">
                <div className="min-w-0 flex-1">
                  <p className="font-value font-medium break-words">{entry.term}</p>
                  <p className="text-muted-foreground text-sm break-words whitespace-pre-line">{entry.meaning}</p>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Edit ${entry.term}`}
                  onClick={() => {
                    setEditingId(entry.id);
                    setDraft({ term: entry.term, meaning: entry.meaning });
                    setRowError(null);
                  }}
                >
                  <Pencil />
                </Button>
                <Button variant="ghost" size="icon" aria-label={`Delete ${entry.term}`} onClick={() => setToDelete(entry)}>
                  <Trash2 />
                </Button>
              </li>
            ),
          )}
        </ul>
      )}

      {listError ? <FormMessage tone="error">{listError}</FormMessage> : null}
      {nextCursor ? (
        <Button variant="outline" size="sm" className="self-start" onClick={loadMore} disabled={busy}>
          Load more entries
        </Button>
      ) : null}

      <form onSubmit={add} className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto] sm:items-end" noValidate>
        <div className="flex flex-col gap-2">
          <Label htmlFor="glossary-term">Term</Label>
          <Input id="glossary-term" className="font-value" placeholder="1 1/2" value={term} onChange={(e) => setTerm(e.target.value)} />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="glossary-meaning">Meaning</Label>
          <Input
            id="glossary-meaning"
            placeholder="1 year and 6 months"
            value={meaning}
            onChange={(e) => setMeaning(e.target.value)}
          />
        </div>
        <Button type="submit" variant="outline" disabled={busy}>
          Add entry
        </Button>
      </form>
      {addError ? <FormMessage tone="error">{addError}</FormMessage> : null}

      <AlertDialog open={toDelete !== null} onOpenChange={(open) => !open && !busy && setToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete the glossary entry “{toDelete?.term}”?</AlertDialogTitle>
            <AlertDialogDescription>
              This deletes 1 glossary entry. Future extractions for this book won&apos;t be told about it. Data
              already extracted is not changed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel type="button" disabled={busy}>
              Cancel
            </AlertDialogCancel>
            <Button variant="destructive" onClick={confirmDelete} disabled={busy}>
              Delete entry
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
