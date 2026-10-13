"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { ExtractDialog } from "@/components/extraction/extract-dialog";
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
import { getJson, postJson } from "@/lib/api-client";
import type { ReadingChanges } from "@/lib/documents/reading-changes";
import { plural } from "@/lib/format";

/**
 * "38 of 120 documents were read before your latest field changes" (decision 88). It only says so:
 * nothing is read again unless the operator asks, and Keep is the free way to say a change (a typo
 * fixed in a name, a note reworded) didn't spoil the readings. Shows nothing when no document is
 * flagged, and counts again whenever the fields on screen change.
 */
export function ReadingChangesBanner({ templateId, watch, onChanged }: { templateId: string; watch: string; onChanged: () => void }) {
  const [changes, setChanges] = useState<ReadingChanges | null>(null);
  const [keepOpen, setKeepOpen] = useState(false);
  const [readOpen, setReadOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const result = await getJson<ReadingChanges>(`/api/templates/${templateId}/reading-changes`);
    // A failed count leaves the last one on screen; the next field change asks again.
    if (result.ok) setChanges(result.data);
  }, [templateId]);

  useEffect(() => {
    // A field save lands a moment after the fields on screen change.
    const timer = setTimeout(() => void load(), 400);
    return () => clearTimeout(timer);
  }, [load, watch]);

  async function keep() {
    if (!changes || pending) return;
    setPending(true);
    setError(null);
    const result = await postJson<{ kept: number }>(`/api/templates/${templateId}/keep-readings`, { impactHash: changes.impactHash });
    setPending(false);
    if (!result.ok) {
      setError(result.error.message);
      void load();
      return;
    }
    toast.success(`Kept ${plural(result.data.kept, "reading")}. Nothing was read again.`);
    setKeepOpen(false);
    await load();
    onChanged();
  }

  if (!changes || changes.changed === 0) return null;
  const { changed, read } = changes;

  return (
    <div role="status" className="flex flex-col gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
      <p>
        {changed} of {plural(read, "document")} {changed === 1 ? "was" : "were"} read before your latest field changes.
      </p>
      <p className="text-muted-foreground text-xs">
        Nothing is read again by itself. Read them again if the change affects what the AI should read; keep the readings if it doesn&apos;t.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => setReadOpen(true)}>
          Read them again…
        </Button>
        <Button size="sm" variant="outline" onClick={() => setKeepOpen(true)}>
          Keep these readings
        </Button>
      </div>

      <ExtractDialog
        target={readOpen ? { templateId, fieldsChanged: true } : null}
        verb="Re-extract"
        onOpenChange={setReadOpen}
        onStarted={() => {
          void load();
          onChanged();
        }}
      />
      <AlertDialog open={keepOpen} onOpenChange={(next) => !pending && setKeepOpen(next)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Keep these readings?</AlertDialogTitle>
            <AlertDialogDescription>
              This keeps the readings of {plural(changed, "document")} as they are and removes the “fields changed since read” mark from{" "}
              {changed === 1 ? "it" : "them"}. Nothing is read again, no cell changes, and it costs nothing. You can still read any of them again
              later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error ? <p className="text-destructive text-sm">{error}</p> : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <Button onClick={() => void keep()} disabled={pending}>
              {pending ? "Keeping…" : `Keep ${plural(changed, "reading")}`}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
