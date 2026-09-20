"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { FormMessage } from "@/components/auth/form-message";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { postJson } from "@/lib/api-client";
import { diffColumns, type EditorColumn } from "@/lib/books/column-diff";
import type { ColumnState } from "@/lib/books/column-ops";
import type { ColumnOp } from "@/lib/books/schemas";
import { plural } from "@/lib/format";
import type { ImpactReport } from "@/lib/impact";

import { ColumnListEditor, toEditorColumn, validateColumns } from "./column-list-editor";
import { ImpactSummary } from "./impact-summary";

/**
 * Output table editor. Saves as a diff of ops: preview first, then apply with the preview's hash.
 * SAFE and ADDITIVE changes apply straight away; DESTRUCTIVE ones stop on the impact report.
 */
type Props = {
  bookId: string;
  columns: ColumnState[];
  /** Controlled from elsewhere (the Mapping tab opens it where the operator finds they need a column). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Called after columns were saved, so a caller with its own copy of them can reload. */
  onSaved?: () => void;
  /** Hidden when the dialog is opened from somewhere else. */
  showTrigger?: boolean;
  /** What the caller calls this action, so the heading matches the button that opened it. */
  title?: string;
};

export function EditColumnsDialog({ bookId, columns, open: openProp, onOpenChange, onSaved, showTrigger = true, title = "Edit output table" }: Props) {
  const router = useRouter();
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const setOpen = (next: boolean) => {
    setOpenState(next);
    onOpenChange?.(next);
  };
  const [step, setStep] = useState<"edit" | "impact">("edit");
  const [working, setWorking] = useState<EditorColumn[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [ops, setOps] = useState<ColumnOp[]>([]);
  const [report, setReport] = useState<ImpactReport | null>(null);
  const [pending, setPending] = useState(false);

  const labels = new Map(columns.map((c) => [c.id, c.label]));
  const previewUrl = `/api/books/${bookId}/columns/preview`;

  // Opening seeds the editor from the book's current columns. In an effect rather than in the open
  // handler, because a caller that controls `open` never goes through that handler.
  useEffect(() => {
    if (!open) return;
    setWorking(columns.map(toEditorColumn));
    setErrors({});
    setMessage(null);
    setReport(null);
    setStep("edit");
    // Re-seeding on every columns change would throw away what is being typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function handleOpenChange(next: boolean) {
    if (pending) return;
    setOpen(next);
  }

  async function save() {
    const found = validateColumns(working);
    setErrors(found);
    if (Object.keys(found).length > 0) {
      setMessage("Fix the highlighted columns first.");
      return;
    }
    const nextOps = diffColumns(columns, working);
    if (nextOps.length === 0) {
      setOpen(false);
      toast("No changes to save.");
      return;
    }
    setMessage(null);
    setPending(true);
    const preview = await postJson<ImpactReport>(previewUrl, { ops: nextOps });
    if (!preview.ok) {
      setPending(false);
      setMessage(preview.error.message);
      return;
    }
    setOps(nextOps);
    setReport(preview.data);
    if (preview.data.severity === "DESTRUCTIVE") {
      setPending(false);
      setStep("impact");
      return;
    }
    await apply(nextOps, preview.data);
  }

  async function apply(currentOps: ColumnOp[], currentReport: ImpactReport) {
    setPending(true);
    const result = await postJson<{ columns: ColumnState[]; report: ImpactReport }>(`/api/books/${bookId}/columns/apply`, {
      ops: currentOps,
      impactHash: currentReport.impactHash,
      confirm: true,
    });
    if (!result.ok) {
      if (result.error.code === "CONFLICT") {
        const fresh = await postJson<ImpactReport>(previewUrl, { ops: currentOps });
        setPending(false);
        if (fresh.ok) {
          setReport(fresh.data);
          setStep("impact");
          setMessage("The output table changed while you were reviewing. Check the updated numbers before confirming.");
        } else {
          setStep("edit");
          setMessage(fresh.error.message);
        }
        return;
      }
      setPending(false);
      setMessage(result.error.message);
      return;
    }
    setPending(false);
    setOpen(false);
    const added = currentOps.filter((op) => op.kind === "add").length;
    const fillable = currentReport.fillableTemplates.map((t) => t.name).join(", ");
    toast.success(
      added > 0
        ? `Output table updated. ${plural(added, "new column")} ${added === 1 ? "stays" : "stay"} empty until a template fills ${added === 1 ? "it" : "them"}.`
        : "Output table updated.",
      added > 0 && fillable !== "" ? { description: `Add a mapping in ${fillable} to fill ${added === 1 ? "it" : "them"}.` } : undefined,
    );
    onSaved?.();
    router.refresh();
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {showTrigger ? (
        <DialogTrigger asChild>
          <Button variant="outline" size="sm">
            Edit output table
          </Button>
        </DialogTrigger>
      ) : null}
      <DialogContent
        className="sm:max-w-4xl"
        showCloseButton={!pending}
        onEscapeKeyDown={(e) => pending && e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        {step === "edit" || !report ? (
          <>
            <DialogHeader>
              <DialogTitle>{title}</DialogTitle>
              <DialogDescription>
                Rename, reorder, add or remove columns. Renaming and reordering never lose data; if a change would,
                you&apos;ll see exactly what it affects before anything is saved.
              </DialogDescription>
            </DialogHeader>
            <ColumnListEditor columns={working} onChange={setWorking} errors={errors} disabled={pending} />
            {message ? <FormMessage tone="error">{message}</FormMessage> : null}
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
                Cancel
              </Button>
              <Button onClick={save} disabled={pending}>
                {pending ? "Checking…" : "Save changes"}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Review the impact</DialogTitle>
              <DialogDescription>This change removes or re-checks existing data. Read the numbers, then confirm.</DialogDescription>
            </DialogHeader>
            <ImpactSummary report={report} columnLabels={labels} />
            {message ? <FormMessage tone="info">{message}</FormMessage> : null}
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  setStep("edit");
                  setMessage(null);
                }}
                disabled={pending}
              >
                Back to editing
              </Button>
              <Button variant="destructive" onClick={() => apply(ops, report)} disabled={pending}>
                {pending ? "Applying…" : "Confirm and apply"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
