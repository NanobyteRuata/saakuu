"use client";

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
import { postJson } from "@/lib/api-client";
import type { DocumentsDeleteImpact } from "@/lib/documents/service";
import { formatCount, plural } from "@/lib/format";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  documentIds: string[];
  onDeleted: (ids: string[]) => void;
};

/** Counted confirmation for deleting documents. Confirm stays disabled until the counts load. */
export function DeleteDocumentsDialog({ open, onOpenChange, documentIds, onDeleted }: Props) {
  const [impact, setImpact] = useState<DocumentsDeleteImpact | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [reload, setReload] = useState(0);
  const key = documentIds.join(",");

  useEffect(() => {
    if (!open || !key) return;
    let cancelled = false;
    setImpact(null);
    setError(null);
    void postJson<DocumentsDeleteImpact>("/api/documents/delete-impact", { ids: key.split(",") }).then((result) => {
      if (cancelled) return;
      if (result.ok) setImpact(result.data);
      else setError(result.error.message);
    });
    return () => {
      cancelled = true;
    };
  }, [open, key, reload]);

  async function confirm() {
    if (!impact) return;
    setPending(true);
    const ids = key.split(",");
    const result = await postJson<{ deleted: number }>("/api/documents/delete", { ids, impactHash: impact.impactHash, confirm: true });
    setPending(false);
    if (!result.ok) {
      setError(result.error.message);
      if (result.error.code === "CONFLICT") setReload((n) => n + 1);
      return;
    }
    toast.success(`Deleted ${plural(result.data.deleted, "document")}.`);
    onOpenChange(false);
    onDeleted(ids);
  }

  return (
    <AlertDialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <AlertDialogContent onEscapeKeyDown={(e) => pending && e.preventDefault()}>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {plural(documentIds.length, "document")}?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="flex flex-col gap-2">
              {impact ? (
                <>
                  <p>
                    Delete {plural(impact.documents, "document")} with {plural(impact.photos, "photo")} and{" "}
                    {plural(impact.rows, "row")} in the output table?
                  </p>
                  <p>
                    {impact.editedCells === 0
                      ? "None of the cells in those rows have been edited by you."
                      : `${formatCount(impact.editedCells)} ${impact.editedCells === 1 ? "cell" : "cells"} in those rows ${impact.editedCells === 1 ? "has" : "have"} been edited by you.`}
                  </p>
                </>
              ) : error ? null : (
                <p>Counting what will be deleted…</p>
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
            {pending ? "Deleting…" : `Delete ${plural(documentIds.length, "document")}`}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
