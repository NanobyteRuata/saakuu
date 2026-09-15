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
import { deleteJson, getJson } from "@/lib/api-client";
import { plural } from "@/lib/format";
import type { PhotoDeleteImpact } from "@/lib/photos/service";
import type { PhotoView } from "@/lib/photos/views";

type Props = {
  target: { photo: PhotoView; page: number } | null;
  onOpenChange: (open: boolean) => void;
  onDeleted: (result: { documentDeleted: boolean }) => void;
};

export function DeletePhotoDialog({ target, onOpenChange, onDeleted }: Props) {
  const [impact, setImpact] = useState<PhotoDeleteImpact | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [reload, setReload] = useState(0);
  const id = target?.photo.id;

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setImpact(null);
    setError(null);
    void getJson<PhotoDeleteImpact>(`/api/photos/${id}/delete-impact`).then((result) => {
      if (cancelled) return;
      if (result.ok) setImpact(result.data);
      else setError(result.error.message);
    });
    return () => {
      cancelled = true;
    };
  }, [id, reload]);

  async function confirm() {
    if (!impact || !id) return;
    setPending(true);
    const result = await deleteJson<{ documentDeleted: boolean }>(`/api/photos/${id}`, { impactHash: impact.impactHash, confirm: true });
    setPending(false);
    if (!result.ok) {
      setError(result.error.message);
      if (result.error.code === "CONFLICT") setReload((n) => n + 1);
      return;
    }
    toast.success(result.data.documentDeleted ? "Deleted the page and its document." : "Deleted the page.");
    onOpenChange(false);
    onDeleted(result.data);
  }

  const label = impact?.documentLabel ?? "this document";

  return (
    <AlertDialog open={target !== null} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <AlertDialogContent onEscapeKeyDown={(e) => pending && e.preventDefault()}>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete page {target?.page}?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div>
              {impact ? (
                impact.deletesDocument ? (
                  <p>This is the only page of “{label}”, so the document is deleted too.</p>
                ) : (
                  <p>
                    “{label}” keeps {plural(impact.pages - 1, "other page")}, renumbered in their current order.
                  </p>
                )
              ) : error ? null : (
                <p>Checking the document…</p>
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
            {pending ? "Deleting…" : impact?.deletesDocument ? "Delete page and document" : "Delete page"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
