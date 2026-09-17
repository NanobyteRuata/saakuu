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
import { postJson } from "@/lib/api-client";
import type { Result } from "@/lib/errors";
import { formatCount, plural } from "@/lib/format";
import type { RowsDeleteImpact, RowsRevertImpact } from "@/lib/table/service";

type Base<I extends { impactHash: string }, R> = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rowIds: string[];
  impactUrl: string;
  actionUrl: string;
  title: string;
  confirmLabel: string;
  pendingLabel: string;
  describe: (impact: I) => React.ReactNode;
  canConfirm?: (impact: I) => boolean;
  onDone: (data: R) => void;
};

/** Counted confirmation: the confirm button stays disabled until the counts load (docs/05 Global). */
function ImpactDialog<I extends { impactHash: string }, R>({ open, onOpenChange, rowIds, impactUrl, actionUrl, title, confirmLabel, pendingLabel, describe, canConfirm, onDone }: Base<I, R>) {
  const [impact, setImpact] = useState<I | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [reload, setReload] = useState(0);
  const key = rowIds.join(",");

  useEffect(() => {
    if (!open || !key) return;
    let cancelled = false;
    setImpact(null);
    setError(null);
    void postJson<I>(impactUrl, { ids: key.split(",") }).then((result) => {
      if (cancelled) return;
      if (result.ok) setImpact(result.data);
      else setError(result.error.message);
    });
    return () => {
      cancelled = true;
    };
  }, [open, key, impactUrl, reload]);

  async function confirm() {
    if (!impact) return;
    setPending(true);
    const result: Result<R> = await postJson<R>(actionUrl, { ids: key.split(","), impactHash: impact.impactHash, confirm: true });
    setPending(false);
    if (!result.ok) {
      setError(result.error.message);
      if (result.error.code === "CONFLICT") setReload((n) => n + 1);
      return;
    }
    onOpenChange(false);
    onDone(result.data);
  }

  return (
    <AlertDialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <AlertDialogContent onEscapeKeyDown={(e) => pending && e.preventDefault()}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="flex flex-col gap-2">{impact ? describe(impact) : error ? null : <p>Counting what this changes…</p>}</div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error ? <FormMessage tone="error">{error}</FormMessage> : null}
        <AlertDialogFooter>
          <AlertDialogCancel type="button" disabled={pending}>
            Cancel
          </AlertDialogCancel>
          <Button type="button" variant="destructive" onClick={confirm} disabled={!impact || pending || (impact !== null && canConfirm ? !canConfirm(impact) : false)}>
            {pending ? pendingLabel : confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

type DialogProps<R> = { open: boolean; onOpenChange: (open: boolean) => void; rowIds: string[]; onDone: (data: R) => void };

export type RevertRowsResult = { cells: import("@/lib/table/types").TableCell[]; affected: import("@/lib/table/types").CellValidationUpdate[]; edits: { editId: string; rowId: string }[] };

export function RevertRowsDialog(props: DialogProps<RevertRowsResult>) {
  return (
    <ImpactDialog<RowsRevertImpact, RevertRowsResult>
      {...props}
      impactUrl="/api/rows/revert-impact"
      actionUrl="/api/rows/revert"
      title={`Revert ${plural(props.rowIds.length, "row")} to extracted?`}
      confirmLabel="Revert to extracted"
      pendingLabel="Reverting…"
      canConfirm={(i) => i.editedCells + i.disagreements > 0}
      describe={(i) =>
        i.editedCells + i.disagreements === 0 ? (
          <p>Nothing to revert: no cell in {props.rowIds.length === 1 ? "this row" : "these rows"} has been edited.</p>
        ) : (
          <>
            <p>
              This puts back the extracted value in {formatCount(i.editedCells)} {i.editedCells === 1 ? "cell" : "cells"} you edited
              {i.disagreements > 0 ? `, and clears ${plural(i.disagreements, "disagreement")}` : ""}.
            </p>
            <p>Undo (⌘Z / Ctrl+Z) takes the cells back one at a time.</p>
          </>
        )
      }
    />
  );
}

export type DeleteRowsResult = { deleted: number; affected: import("@/lib/table/types").CellValidationUpdate[] };

export function DeleteRowsDialog(props: DialogProps<DeleteRowsResult>) {
  return (
    <ImpactDialog<RowsDeleteImpact, DeleteRowsResult>
      {...props}
      impactUrl="/api/rows/delete-impact"
      actionUrl="/api/rows/delete"
      title={`Delete ${plural(props.rowIds.length, "row")}?`}
      confirmLabel={`Delete ${plural(props.rowIds.length, "row")}`}
      pendingLabel="Deleting…"
      describe={(i) => (
        <>
          <p>
            This removes {plural(i.rows, "row")} with {plural(i.cells, "filled cell")} from the table and the export. Re-extracting the document won&apos;t bring{" "}
            {i.rows === 1 ? "it" : "them"} back.
          </p>
          <p>
            {i.editedCells === 0 ? "None of these cells have been edited by you." : `${formatCount(i.editedCells)} of these cells ${i.editedCells === 1 ? "has" : "have"} been edited by you.`}
            {i.reviewedCells > 0 ? ` ${formatCount(i.reviewedCells)} ${i.reviewedCells === 1 ? "was" : "were"} marked reviewed.` : ""}
          </p>
        </>
      )}
    />
  );
}
