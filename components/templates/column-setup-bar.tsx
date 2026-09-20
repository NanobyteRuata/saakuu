"use client";

import { Sparkles, Table2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { EditColumnsDialog } from "@/components/books/edit-columns-dialog";
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
import type { ColumnState } from "@/lib/books/column-ops";
import { COLUMN_TYPE_LABELS } from "@/lib/books/schemas";
import { plural } from "@/lib/format";
import type { ColumnProposal } from "@/lib/mappings/service";

type Props = {
  bookId: string;
  templateId: string;
  lang: string | undefined;
  /** Reloads the mappings and the template after columns or mappings changed. */
  onApplied: (message?: string) => Promise<void>;
};

/**
 * `Create columns from this template` and `Edit output columns` (docs/05 §7, decision 52). Setting up
 * the output table belongs where the operator discovers they need it: here, and on the Result Table.
 */
export function ColumnSetupBar({ bookId, templateId, lang, onApplied }: Props) {
  const [proposal, setProposal] = useState<ColumnProposal | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [columns, setColumns] = useState<ColumnState[] | null>(null);
  const [editing, setEditing] = useState(false);

  const loadProposal = useCallback(async () => {
    const result = await getJson<ColumnProposal>(`/api/templates/${templateId}/column-proposal`);
    if (result.ok) setProposal(result.data);
  }, [templateId]);

  const loadColumns = useCallback(async () => {
    const result = await getJson<ColumnState[]>(`/api/books/${bookId}/columns`);
    if (result.ok) setColumns(result.data);
    else toast.error(result.error.message);
  }, [bookId]);

  useEffect(() => {
    void loadProposal();
  }, [loadProposal]);

  async function openEditor() {
    await loadColumns();
    setEditing(true);
  }

  async function create() {
    setPending(true);
    const result = await postJson<{ columns: number; mappings: number }>(`/api/templates/${templateId}/column-proposal`, {});
    setPending(false);
    if (!result.ok) {
      toast.error(result.error.message);
      return;
    }
    setConfirming(false);
    const { columns: made, mappings } = result.data;
    await loadProposal();
    await onApplied(
      made === 0
        ? "Every field this template reads already fills a column."
        : `Created ${plural(made, "column")} and ${plural(mappings, "mapping")}. Rename what needs renaming; rows are being rebuilt.`,
    );
  }

  const items = proposal?.items ?? [];
  /** The proposer stops at the book's limit: at it, fields it would have proposed were dropped. */
  const capped = proposal !== null && proposal.liveColumns + items.length === proposal.maxColumns;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {items.length > 0 ? (
        <Button size="sm" onClick={() => setConfirming(true)}>
          <Sparkles />
          Create columns from this template
        </Button>
      ) : null}
      <Button size="sm" variant="outline" onClick={() => void openEditor()}>
        <Table2 />
        Edit output columns
      </Button>

      {columns ? (
        <EditColumnsDialog
          bookId={bookId}
          columns={columns}
          title="Edit output columns"
          open={editing}
          onOpenChange={setEditing}
          showTrigger={false}
          // The dialog says what it saved; this only reloads what the change affects here.
          onSaved={() => void onApplied().then(loadProposal)}
        />
      ) : null}

      <AlertDialog open={confirming} onOpenChange={(next) => !pending && setConfirming(next)}>
        <AlertDialogContent onEscapeKeyDown={(e) => pending && e.preventDefault()}>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Creates {plural(items.length, "column")} and {plural(items.length, "mapping")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              One column per field this template reads that nothing fills yet, copied straight across. Rename or delete
              any of them afterwards in the output table; nothing is read again and no AI cost is involved.
            </AlertDialogDescription>
          </AlertDialogHeader>

          <ul className="max-h-64 overflow-y-auto rounded-md border text-sm" aria-label="Columns to create">
            {items.map((item) => (
              <li key={`${item.source.kind}-${item.source.id}`} className="flex items-baseline justify-between gap-3 border-b px-3 py-1.5 last:border-b-0">
                <span className="min-w-0 truncate">
                  <span lang={lang} className="font-value">
                    {item.sourcePath}
                  </span>{" "}
                  → {item.label}
                </span>
                <span className="text-muted-foreground shrink-0 text-xs">{COLUMN_TYPE_LABELS[item.dataType]}</span>
              </li>
            ))}
          </ul>
          {capped ? (
            <p className="text-muted-foreground text-sm">
              The book is at its limit of {proposal?.maxColumns} columns, so some fields were left out.
            </p>
          ) : null}

          <AlertDialogFooter>
            <AlertDialogCancel type="button" disabled={pending}>
              Cancel
            </AlertDialogCancel>
            <Button type="button" onClick={() => void create()} disabled={pending}>
              {pending ? "Creating…" : `Create ${plural(items.length, "column")}`}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
