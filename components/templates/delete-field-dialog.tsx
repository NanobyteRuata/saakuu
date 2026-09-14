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
import { getJson, postJson } from "@/lib/api-client";
import { formatCount, plural } from "@/lib/format";
import type { FieldsDeleteImpact } from "@/lib/templates/fields-service";
import type { FieldView } from "@/lib/templates/views";

type Props = {
  field: FieldView | null;
  lang: string | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted: (field: FieldView) => void | Promise<void>;
};

/**
 * Counted confirmation for a field soft delete. Confirm is disabled until the counts load, and
 * the server refuses the delete if the counts changed since.
 */
export function DeleteFieldDialog({ field, lang, open, onOpenChange, onDeleted }: Props) {
  const [impact, setImpact] = useState<FieldsDeleteImpact | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [reload, setReload] = useState(0);
  const id = field?.id;

  useEffect(() => {
    if (!open || !id) return;
    let cancelled = false;
    setImpact(null);
    setError(null);
    void getJson<FieldsDeleteImpact>(`/api/fields/${id}/delete-impact`).then((result) => {
      if (cancelled) return;
      if (result.ok) setImpact(result.data);
      else setError(result.error.message);
    });
    return () => {
      cancelled = true;
    };
  }, [open, id, reload]);

  async function confirm() {
    if (!impact || !field) return;
    setPending(true);
    const result = await postJson<{ deleted: number }>("/api/fields/delete", {
      ids: [field.id],
      impactHash: impact.impactHash,
      confirm: true,
    });
    setPending(false);
    if (!result.ok) {
      setError(result.error.message);
      if (result.error.code === "CONFLICT") setReload((n) => n + 1);
      return;
    }
    onOpenChange(false);
    await onDeleted(field);
  }

  return (
    <AlertDialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <AlertDialogContent onEscapeKeyDown={(e) => pending && e.preventDefault()}>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Delete the field “<span lang={lang} className="font-value">{field?.labelSource}</span>”?
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="flex flex-col gap-2" data-testid="field-delete-impact">
              <p>
                It&apos;s removed from this template and from future extractions, and listed under Deleted fields where
                you can restore it.
              </p>
              {impact ? (
                <>
                  <p>
                    {impact.rawValues === 0
                      ? "No values have been read for this field yet."
                      : `${plural(impact.rawValues, "value")} already read for it ${impact.rawValues === 1 ? "is" : "are"} kept and come${impact.rawValues === 1 ? "s" : ""} back if you restore it.`}
                  </p>
                  {impact.brokenMappings.length === 0 ? (
                    <p>No mappings break.</p>
                  ) : (
                    <div>
                      <p>
                        {plural(impact.brokenMappings.length, "mapping")} will break, and the template shows as Conflicted
                        until {impact.brokenMappings.length === 1 ? "it's" : "they're"} fixed:
                      </p>
                      <ul className="mt-1 list-disc pl-5">
                        {impact.brokenMappings.map((m, i) => (
                          <li key={i}>{m.columnLabel}</li>
                        ))}
                      </ul>
                      <p className="mt-1">
                        {formatCount(impact.editedCells)} of the {plural(impact.affectedCells, "affected cell")}{" "}
                        {impact.editedCells === 1 ? "has" : "have"} been edited by you.
                      </p>
                    </div>
                  )}
                  {impact.clearsSequence ? (
                    <p>
                      This is the sequence field. The table has no sequence field until you restore it or choose another.
                    </p>
                  ) : null}
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
            {pending ? "Deleting…" : "Delete field"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
