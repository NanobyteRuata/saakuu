"use client";

import { useEffect, useState } from "react";

import { FormMessage } from "@/components/auth/form-message";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { postJson } from "@/lib/api-client";
import { exportTokenSchema } from "@/lib/books/schemas";
import type { ExportOptions } from "@/lib/export/schemas";
import type { ExportPreview } from "@/lib/export/service";
import { formatCount, plural } from "@/lib/format";

export type ExportColumn = { id: string; key: string; label: string };

type Props = {
  bookId: string;
  columns: ExportColumn[];
  blankToken: string;
  illegibleToken: string;
  rowCount: number;
  /** Button style where it is placed. */
  variant?: "outline" | "default";
  size?: "sm" | "default";
};

const PREVIEW_DEBOUNCE_MS = 250;

/**
 * Export CSV (docs/05 §14): options, the resulting row count, and warnings with exact counts for unreviewed cells
 * and validation errors. Warnings never block.
 */
export function ExportButton({ bookId, columns, blankToken, illegibleToken, rowCount, variant = "outline", size = "default" }: Props) {
  const [open, setOpen] = useState(false);
  if (rowCount === 0) {
    return (
      <span title="Export becomes available once there are rows.">
        <Button variant={variant} size={size} disabled>
          Export CSV
        </Button>
      </span>
    );
  }
  return (
    <>
      <Button variant={variant} size={size} onClick={() => setOpen(true)}>
        Export CSV
      </Button>
      {open ? <ExportDialog bookId={bookId} columns={columns} blankToken={blankToken} illegibleToken={illegibleToken} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function ExportDialog({ bookId, columns, blankToken, illegibleToken, onClose }: Omit<Props, "rowCount" | "variant" | "size"> & { onClose: () => void }) {
  const [includeVoid, setIncludeVoid] = useState(false);
  const [includeProvenance, setIncludeProvenance] = useState(false);
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(columns.map((c) => c.id)));
  const [blank, setBlank] = useState(blankToken);
  const [illegible, setIllegible] = useState(illegibleToken);
  const [preview, setPreview] = useState<ExportPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const tokensValid = exportTokenSchema.safeParse(blank).success && exportTokenSchema.safeParse(illegible).success;
  const options: ExportOptions = {
    includeVoid,
    includeProvenance,
    ...(chosen.size < columns.length ? { columns: columns.filter((c) => chosen.has(c.id)).map((c) => c.id) } : {}),
    blankToken: blank,
    illegibleToken: illegible,
  };
  const columnsKey = options.columns?.join(",") ?? null;

  useEffect(() => {
    if (chosen.size === 0) return;
    let cancelled = false;
    setPreview(null);
    const t = window.setTimeout(() => {
      void postJson<ExportPreview>(`/api/books/${bookId}/export/preview`, { includeVoid, ...(columnsKey ? { columns: columnsKey.split(",") } : {}) }).then((result) => {
        if (cancelled) return;
        if (result.ok) {
          setPreview(result.data);
          setError(null);
        } else setError(result.error.message);
      });
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [bookId, includeVoid, columnsKey, chosen.size]);

  async function onExport() {
    setPending(true);
    const result = await postJson<{ downloadUrl: string }>(`/api/books/${bookId}/export`, options);
    setPending(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    // The response is an attachment, so the browser downloads it and stays on this page.
    const a = document.createElement("a");
    a.href = result.data.downloadUrl;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    onClose();
  }

  function toggleColumn(id: string, on: boolean) {
    setChosen((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !pending && onClose()}>
      <DialogContent className="flex max-h-[90vh] flex-col sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Export CSV</DialogTitle>
          <DialogDescription>UTF-8 with a byte order mark, so Burmese text opens correctly in Excel. Rows follow the table&apos;s manual order.</DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto pr-1">
          <div className="flex flex-col gap-2">
            <div className="flex items-start gap-2">
              <Checkbox id="export-void" className="mt-0.5" checked={includeVoid} onCheckedChange={(v) => setIncludeVoid(v === true)} />
              <Label htmlFor="export-void" className="flex flex-col items-start gap-0.5 font-normal">
                Include void rows
                <span className="text-muted-foreground text-xs">Adds a _void column saying which rows are void.</span>
              </Label>
            </div>
            <div className="flex items-start gap-2">
              <Checkbox id="export-provenance" className="mt-0.5" checked={includeProvenance} onCheckedChange={(v) => setIncludeProvenance(v === true)} />
              <Label htmlFor="export-provenance" className="flex flex-col items-start gap-0.5 font-normal">
                Include source columns
                <span className="text-muted-foreground text-xs">_document, _template, _photo (page), _model, _reviewed, _confidence (lowest in the row)</span>
              </Label>
            </div>
          </div>

          <div role="group" aria-labelledby="export-columns-label" className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <p id="export-columns-label" className="text-sm font-medium">
                Columns · {formatCount(chosen.size)} of {formatCount(columns.length)}
              </p>
              <Button variant="ghost" size="sm" onClick={() => setChosen(chosen.size === columns.length ? new Set() : new Set(columns.map((c) => c.id)))}>
                {chosen.size === columns.length ? "Clear all" : "Select all"}
              </Button>
            </div>
            <div className="grid max-h-48 gap-1.5 overflow-y-auto rounded-md border p-2 sm:grid-cols-2">
              {columns.map((c) => (
                <div key={c.id} className="flex min-w-0 items-center gap-2">
                  <Checkbox id={`export-col-${c.id}`} checked={chosen.has(c.id)} onCheckedChange={(v) => toggleColumn(c.id, v === true)} />
                  <Label htmlFor={`export-col-${c.id}`} className="min-w-0 truncate font-normal" title={`${c.label} (${c.key})`}>
                    {c.label}
                  </Label>
                </div>
              ))}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="export-dialog-blank">Blank cells export as</Label>
              <Input id="export-dialog-blank" className="font-mono" placeholder="(empty)" value={blank} onChange={(e) => setBlank(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="export-dialog-illegible">Illegible cells export as</Label>
              <Input id="export-dialog-illegible" className="font-mono" value={illegible} onChange={(e) => setIllegible(e.target.value)} />
            </div>
            <p className="text-muted-foreground text-xs sm:col-span-2">Dashes export as - and not-applicable as N/A. What you choose here is remembered for this book&apos;s next export.</p>
          </div>

          <div aria-live="polite" className="flex flex-col gap-2 text-sm">
            {chosen.size === 0 ? (
              <FormMessage tone="error">Choose at least one column.</FormMessage>
            ) : !tokensValid ? (
              <FormMessage tone="error">Keep tokens to 20 characters or fewer.</FormMessage>
            ) : preview ? (
              <>
                <p>
                  {plural(preview.rows, "row")} × {plural(preview.columns, "column")}
                </p>
                {preview.unreviewedCells > 0 || preview.errorCells > 0 || preview.warningCells > 0 ? (
                  <FormMessage tone="info">
                    Not finished: {[
                      preview.unreviewedCells > 0 ? `${formatCount(preview.unreviewedCells)} of ${formatCount(preview.cells)} cells not reviewed` : null,
                      preview.errorCells > 0 ? plural(preview.errorCells, "cell") + " with errors" : null,
                      preview.warningCells > 0 ? plural(preview.warningCells, "cell") + " with warnings" : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                    . You can still export.
                  </FormMessage>
                ) : (
                  <p className="text-muted-foreground">Every exported cell is reviewed and has no validation flags.</p>
                )}
              </>
            ) : error ? null : (
              <p className="text-muted-foreground">Counting rows…</p>
            )}
            {error ? <FormMessage tone="error">{error}</FormMessage> : null}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={() => void onExport()} disabled={pending || chosen.size === 0 || !tokensValid || !preview}>
            {pending ? "Preparing…" : preview ? `Export ${plural(preview.rows, "row")}` : "Export"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
