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
import { getJson, postJson } from "@/lib/api-client";
import { formatCount, plural } from "@/lib/format";
import type { TemplatesDeleteImpact } from "@/lib/templates/service";

type Props = {
  template: { id: string; name: string } | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted: (id: string) => void;
};

/** Counted confirmation for deleting a template. Confirm stays disabled until the counts load. */
export function DeleteTemplateDialog({ template, open, onOpenChange, onDeleted }: Props) {
  const [impact, setImpact] = useState<TemplatesDeleteImpact | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [reload, setReload] = useState(0);
  const id = template?.id;

  useEffect(() => {
    if (!open || !id) return;
    let cancelled = false;
    setImpact(null);
    setError(null);
    void getJson<TemplatesDeleteImpact>(`/api/templates/${id}/delete-impact`).then((result) => {
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
    const result = await postJson<{ deleted: number }>("/api/templates/delete", {
      ids: [id],
      impactHash: impact.impactHash,
      confirm: true,
    });
    setPending(false);
    if (!result.ok) {
      setError(result.error.message);
      if (result.error.code === "CONFLICT") setReload((n) => n + 1);
      return;
    }
    toast.success(`Deleted the template “${template?.name}”.`);
    onOpenChange(false);
    onDeleted(id);
  }

  return (
    <AlertDialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <AlertDialogContent onEscapeKeyDown={(e) => pending && e.preventDefault()}>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete the template “{template?.name}”?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="flex flex-col gap-2">
              {impact ? (
                <>
                  <p>
                    Delete 1 template, {plural(impact.documents, "document")},{" "}
                    {impact.specimens > 0 ? `${plural(impact.specimens, "specimen")}, ` : ""}
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
            {pending ? "Deleting…" : "Delete template"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
