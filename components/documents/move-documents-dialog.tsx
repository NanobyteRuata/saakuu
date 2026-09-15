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
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { postJson } from "@/lib/api-client";
import type { DocumentsMoveImpact } from "@/lib/documents/service";
import { formatCount, plural } from "@/lib/format";

import type { TemplateOption } from "./documents-view";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  documentIds: string[];
  templates: TemplateOption[];
  onMoved: () => void;
};

/**
 * Move documents to another template (docs/04 → Move semantics). Field ids differ between templates,
 * so extraction results and typed values are discarded; the dialog says exactly how much.
 */
export function MoveDocumentsDialog({ open, onOpenChange, documentIds, templates, onMoved }: Props) {
  const [targetId, setTargetId] = useState<string | null>(null);
  const [impact, setImpact] = useState<DocumentsMoveImpact | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [reload, setReload] = useState(0);
  const key = documentIds.join(",");

  useEffect(() => {
    if (!open) {
      setTargetId(null);
      setImpact(null);
      setError(null);
    }
  }, [open]);

  useEffect(() => {
    if (!open || !key || !targetId) return;
    let cancelled = false;
    setImpact(null);
    setError(null);
    void postJson<DocumentsMoveImpact>("/api/documents/move-impact", { ids: key.split(","), targetTemplateId: targetId }).then((result) => {
      if (cancelled) return;
      if (result.ok) setImpact(result.data);
      else setError(result.error.message);
    });
    return () => {
      cancelled = true;
    };
  }, [open, key, targetId, reload]);

  async function confirm() {
    if (!impact || !targetId) return;
    setPending(true);
    const result = await postJson<{ moved: number }>("/api/documents/move", {
      ids: key.split(","),
      targetTemplateId: targetId,
      impactHash: impact.impactHash,
      confirm: true,
    });
    setPending(false);
    if (!result.ok) {
      setError(result.error.message);
      if (result.error.code === "CONFLICT") setReload((n) => n + 1);
      return;
    }
    toast.success(`Moved ${plural(result.data.moved, "document")} to “${impact.targetTemplateName}”.`);
    onOpenChange(false);
    onMoved();
  }

  const discards = impact ? impact.rawValues + impact.rows + impact.manualValueDocuments > 0 : false;

  return (
    <AlertDialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <AlertDialogContent onEscapeKeyDown={(e) => pending && e.preventDefault()}>
        <AlertDialogHeader>
          <AlertDialogTitle>Move {plural(documentIds.length, "document")} to another template</AlertDialogTitle>
          <AlertDialogDescription>
            Photos and page order move with the documents. What was read from them doesn&apos;t, because the new template
            has different fields.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex flex-col gap-2">
          <Label htmlFor="move-target">Move to</Label>
          <Select value={targetId ?? undefined} onValueChange={setTargetId} disabled={pending}>
            <SelectTrigger id="move-target">
              <SelectValue placeholder="Choose a template" />
            </SelectTrigger>
            <SelectContent>
              {templates.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.name} ({t.kind === "TABLE" ? "Table" : "Form"})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {targetId && !impact && !error ? <p className="text-muted-foreground text-sm">Counting what will change…</p> : null}
        {impact ? (
          <div className="flex flex-col gap-2 text-sm">
            <p>
              Move {plural(impact.documents, "document")} with {plural(impact.photos, "photo")} to “{impact.targetTemplateName}”.
              {impact.alreadyOnTarget > 0 ? ` ${plural(impact.alreadyOnTarget, "document")} already there will stay as they are.` : ""}
            </p>
            {discards ? (
              <div className="border-destructive/40 bg-destructive/5 flex flex-col gap-1 rounded-md border p-3">
                <p className="font-medium">This discards:</p>
                <ul className="list-disc pl-5">
                  <li>{plural(impact.rawValues, "extracted value")}</li>
                  <li>
                    {plural(impact.rows, "row")} and {plural(impact.cells, "cell")} in the output table, of which{" "}
                    <strong>{formatCount(impact.editedCells)} edited by you</strong> and {formatCount(impact.reviewedCells)} reviewed
                  </li>
                  <li>typed values on {plural(impact.manualValueDocuments, "document")}</li>
                </ul>
              </div>
            ) : (
              <p className="text-muted-foreground">Nothing has been extracted or typed on these documents yet, so nothing is lost.</p>
            )}
            <p>The documents will need to be extracted again with the new template.</p>
          </div>
        ) : null}
        {error ? <FormMessage tone="error">{error}</FormMessage> : null}
        <AlertDialogFooter>
          <AlertDialogCancel type="button" disabled={pending}>
            Cancel
          </AlertDialogCancel>
          <Button type="button" variant={discards ? "destructive" : "default"} onClick={confirm} disabled={!impact || pending}>
            {pending ? "Moving…" : `Move ${plural(impact?.documents ?? documentIds.length, "document")}`}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
