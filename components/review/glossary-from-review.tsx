"use client";

import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";

import { FormMessage } from "@/components/auth/form-message";
import { valueLang } from "@/components/table/table-cell";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { postJson } from "@/lib/api-client";
import type { GlossaryEntryView } from "@/lib/books/glossary-service";
import { glossaryEntryInputSchema } from "@/lib/books/schemas";

type Props = {
  bookId: string;
  /** The term to explain, or null when closed. */
  term: string | null;
  onClose: () => void;
};

/**
 * Add to glossary from review (docs/06 Phase 19). The glossary reaches every prompt, but it is *discovered* mid-review —
 * the third time the operator meets `ဒီ` meaning ditto — so it is offered where that happens, and the next extraction
 * reads it. The same endpoint and schema as the Settings editor; nothing else is written.
 */
export function GlossaryFromReview({ bookId, term, onClose }: Props) {
  const [draftTerm, setDraftTerm] = useState("");
  const [meaning, setMeaning] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (term === null) return;
    setDraftTerm(term);
    setMeaning("");
    setError(null);
  }, [term]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const parsed = glossaryEntryInputSchema.safeParse({ term: draftTerm, meaning });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Check the term and meaning.");
      return;
    }
    setBusy(true);
    const result = await postJson<GlossaryEntryView>(`/api/books/${bookId}/glossary`, parsed.data);
    setBusy(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    toast.success(`Added “${result.data.term}” to the glossary. The next extraction will use it.`);
    onClose();
  }

  return (
    <Dialog open={term !== null} onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>Add to glossary</DialogTitle>
            <DialogDescription>Explain what people wrote. Every extraction in this book will read it; it doesn&apos;t change any value already read.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="glossary-review-term">Term, as written on the paper</Label>
            <Input id="glossary-review-term" className="font-value" lang={valueLang(draftTerm)} value={draftTerm} onChange={(e) => setDraftTerm(e.target.value)} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="glossary-review-meaning">What it means</Label>
            <Textarea
              id="glossary-review-meaning"
              autoFocus
              rows={3}
              placeholder="e.g. a ditto mark: the same as the row above"
              value={meaning}
              onChange={(e) => setMeaning(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  e.currentTarget.form?.requestSubmit();
                }
              }}
            />
          </div>
          {error ? <FormMessage tone="error">{error}</FormMessage> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Adding…" : "Add to glossary"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
