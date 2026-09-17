"use client";

import { useEffect, useState } from "react";

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
import { deleteJson, getJson } from "@/lib/api-client";
import { plural } from "@/lib/format";
import type { MappingDeleteImpact } from "@/lib/mappings/service";

type Props = {
  mappingId: string | null;
  columnLabel: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted: () => void | Promise<void>;
};

/** Counted confirmation for deleting a mapping. Confirm stays disabled until the counts load. */
export function DeleteMappingDialog({ mappingId, columnLabel, open, onOpenChange, onDeleted }: Props) {
  const [impact, setImpact] = useState<MappingDeleteImpact | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (open) setError(null);
  }, [open, mappingId]);

  useEffect(() => {
    if (!open || !mappingId) return;
    let cancelled = false;
    setImpact(null);
    void getJson<MappingDeleteImpact>(`/api/mappings/${mappingId}/delete-impact`).then((result) => {
      if (cancelled) return;
      if (result.ok) setImpact(result.data);
      else setError(result.error.message);
    });
    return () => {
      cancelled = true;
    };
  }, [open, mappingId, reload]);

  async function confirm() {
    if (!impact || !mappingId) return;
    setPending(true);
    const result = await deleteJson<unknown>(`/api/mappings/${mappingId}`, { impactHash: impact.impactHash, confirm: true });
    setPending(false);
    if (!result.ok) {
      setError(result.error.message);
      if (result.error.code === "CONFLICT") setReload((n) => n + 1);
      return;
    }
    onOpenChange(false);
    await onDeleted();
  }

  return (
    <AlertDialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <AlertDialogContent onEscapeKeyDown={(e) => pending && e.preventDefault()}>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete the mapping for “{columnLabel}”?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="flex flex-col gap-2" data-testid="mapping-delete-impact">
              {impact ? (
                <>
                  <p>
                    {impact.clearedCells === 0
                      ? `No cells in “${impact.columnLabel}” have a value from this template yet, so nothing is cleared.`
                      : `${plural(impact.clearedCells, "cell")} in “${impact.columnLabel}” across ${plural(impact.documents, "document")} ${impact.clearedCells === 1 ? "empties" : "empty"} when rows are rebuilt.`}
                  </p>
                  {impact.editedCells > 0 ? (
                    <p>
                      {plural(impact.editedCells, "cell")} you edited in that column {impact.editedCells === 1 ? "keeps its" : "keep their"} value.
                    </p>
                  ) : null}
                  <p>The raw values stay, so mapping the column again restores it at no AI cost.</p>
                </>
              ) : error ? null : (
                <p>Counting what this affects…</p>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error ? <FormMessage tone="error">{error}</FormMessage> : null}
        <AlertDialogFooter>
          <AlertDialogCancel type="button" disabled={pending}>
            Cancel
          </AlertDialogCancel>
          <Button type="button" variant="destructive" onClick={confirm} disabled={!impact || pending}>
            {pending ? "Deleting…" : "Delete mapping"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
