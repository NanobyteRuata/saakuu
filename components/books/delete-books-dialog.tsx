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
import { formatCount, plural } from "@/lib/format";
import type { BooksDeleteImpact } from "@/lib/impact";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  books: { id: string; name: string }[];
  onDeleted: (ids: string[]) => void;
};

/**
 * Counted confirmation for deleting one or more books. The confirm button stays disabled until
 * the server has counted the damage, and the delete is refused if those counts go stale.
 */
export function DeleteBooksDialog({ open, onOpenChange, books, onDeleted }: Props) {
  const [impact, setImpact] = useState<BooksDeleteImpact | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [reload, setReload] = useState(0);
  const idsKey = books.map((b) => b.id).join(",");

  useEffect(() => {
    if (!open || !idsKey) return;
    let cancelled = false;
    setImpact(null);
    void postJson<BooksDeleteImpact>("/api/books/delete-impact", { ids: idsKey.split(",") }).then((result) => {
      if (cancelled) return;
      if (result.ok) setImpact(result.data);
      else setError(result.error.message);
    });
    return () => {
      cancelled = true;
    };
  }, [open, idsKey, reload]);

  function handleOpenChange(next: boolean) {
    if (pending) return;
    if (!next) setError(null);
    onOpenChange(next);
  }

  async function confirm() {
    if (!impact) return;
    setPending(true);
    setError(null);
    const ids = idsKey.split(",");
    const result = await postJson<{ deleted: number }>("/api/books/delete", {
      ids,
      impactHash: impact.impactHash,
      confirm: true,
    });
    setPending(false);
    if (!result.ok) {
      setError(result.error.message);
      if (result.error.code === "CONFLICT") setReload((n) => n + 1);
      return;
    }
    toast.success(`Deleted ${plural(result.data.deleted, "book")}.`);
    onOpenChange(false);
    onDeleted(ids);
  }

  const only = books.length === 1 ? books[0] : undefined;

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogContent onEscapeKeyDown={(e) => pending && e.preventDefault()}>
        <AlertDialogHeader>
          <AlertDialogTitle>{only ? `Delete “${only.name}”?` : `Delete ${plural(books.length, "book")}?`}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="flex flex-col gap-2">
              {impact ? (
                <>
                  <p>
                    Delete {plural(impact.books, "book")}, {plural(impact.documents, "document")},{" "}
                    {plural(impact.photos, "photo")} and {plural(impact.rows, "row")}?
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
            {pending ? "Deleting…" : only ? "Delete book" : `Delete ${plural(books.length, "book")}`}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
