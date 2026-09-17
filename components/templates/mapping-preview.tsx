"use client";

import { useEffect, useMemo, useState } from "react";

import { FormMessage } from "@/components/auth/form-message";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { postJson } from "@/lib/api-client";
import { plural } from "@/lib/format";
import type { MappingDraft } from "@/lib/mappings/schemas";
import type { ColumnOption, MappingPreview, PreviewCell } from "@/lib/mappings/service";
import { VOID_REASON_LABELS } from "@/lib/table/labels";
import { cn } from "@/lib/utils";

function cellText(cell: PreviewCell): string {
  if (cell.state === "ILLEGIBLE") return "?";
  if (cell.state === "DASH") return "–";
  if (cell.state === "NOT_APPLICABLE") return "n/a";
  return cell.value ?? "";
}

type Props = {
  templateId: string;
  columns: ColumnOption[];
  /** Columns this template fills, plus the one being edited. */
  shownColumnIds: ReadonlySet<string>;
  /** The mapping being edited, unsaved; null previews the saved mappings. */
  draft: (MappingDraft & { id: string | null }) | null;
  focusColumnId: string | null;
  lang: string | undefined;
};

/**
 * The mappings applied to a real document's raw values before anything runs (docs/05 §7). Nothing is
 * written. Shows up to 50 rows, void rows labelled, and every flagged cell's message in words.
 */
export function MappingPreviewPanel({ templateId, columns, shownColumnIds, draft, focusColumnId, lang }: Props) {
  const [documentId, setDocumentId] = useState<string | undefined>(undefined);
  const [preview, setPreview] = useState<MappingPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const request = useMemo(() => ({ documentId, draft: draft ?? undefined }), [documentId, draft]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    // Debounced, so typing in the editor doesn't send a request per keystroke.
    const timer = setTimeout(() => {
      void postJson<MappingPreview>(`/api/templates/${templateId}/mappings/preview`, request).then((result) => {
        if (cancelled) return;
        setLoading(false);
        if (result.ok) {
          setPreview(result.data);
          setError(null);
        } else {
          setError(result.error.message);
        }
      });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [templateId, request]);

  const shown = columns.filter((c) => shownColumnIds.has(c.id));
  const flagged = (preview?.rows ?? []).flatMap((row, i) =>
    shown.flatMap((c) => {
      const cell = row.cells[c.id];
      return cell && cell.validationState !== "NONE" ? [{ row: i + 1, column: c.label, cell }] : [];
    }),
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Preview</h3>
        {preview && preview.documents.length > 0 ? (
          <Select value={preview.document?.id} onValueChange={setDocumentId}>
            <SelectTrigger className="w-56" aria-label="Document to preview">
              <SelectValue placeholder="Choose a document" />
            </SelectTrigger>
            <SelectContent>
              {preview.documents.map((d) => (
                <SelectItem key={d.id} value={d.id}>
                  {d.label ?? "Untitled document"}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
      </div>
      <p className="text-muted-foreground text-xs">
        {draft ? "Your unsaved change applied to the saved mappings. " : ""}Worked out from what the AI read; nothing is saved.
        {loading && preview ? " Updating…" : ""}
      </p>

      {error ? <FormMessage tone="error">{error}</FormMessage> : null}
      {preview?.draftProblem ? <FormMessage tone="error">This mapping can&apos;t be used yet: {preview.draftProblem}</FormMessage> : null}

      {!preview ? (
        error ? null : <p className="text-muted-foreground text-sm">Loading the preview…</p>
      ) : !preview.document ? (
        <div className="rounded-lg border border-dashed px-4 py-8 text-center">
          <p className="font-medium">No extracted documents yet</p>
          <p className="text-muted-foreground text-sm">Extract a document with this template to see its real values here.</p>
        </div>
      ) : shown.length === 0 ? (
        <p className="text-muted-foreground text-sm">Map a column to see its values for this document.</p>
      ) : preview.totalRows === 0 ? (
        <p className="text-muted-foreground text-sm">This document produced no rows (a blank page, or no rows were found).</p>
      ) : (
        <>
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left">
                <tr>
                  <th className="border-b px-2 py-1 font-medium">Row</th>
                  {shown.map((c) => (
                    <th key={c.id} className={cn("border-b px-2 py-1 font-medium whitespace-nowrap", c.id === focusColumnId && "bg-primary/10")}>
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((row, i) => (
                  <tr key={`${row.recordKey}-${i}`} className={cn(row.voidReason && "text-muted-foreground")}>
                    <td className="border-b px-2 py-1 whitespace-nowrap tabular-nums">
                      {i + 1}
                      {row.voidReason ? <span className="ml-1 text-xs">({VOID_REASON_LABELS[row.voidReason]}, void)</span> : null}
                    </td>
                    {shown.map((c) => {
                      const cell = row.cells[c.id];
                      return (
                        <td
                          key={c.id}
                          title={cell && cell.validationMsgs.length > 0 ? cell.validationMsgs.join("\n") : undefined}
                          className={cn(
                            "max-w-48 truncate border-b px-2 py-1",
                            c.id === focusColumnId && "bg-primary/5",
                            cell?.validationState === "ERROR" && "border-l-destructive border-l-2",
                            cell?.validationState === "WARNING" && "border-l-2 border-l-amber-500",
                          )}
                        >
                          {cell ? (
                            <>
                              {cell.inherited ? (
                                <span className="text-muted-foreground mr-1 text-[10px]" title="Copied from the row above (ditto mark)">
                                  ⇡
                                </span>
                              ) : null}
                              <span lang={lang} className={cn("font-value tabular-nums", cell.state !== "OK" && "text-muted-foreground")}>
                                {cellText(cell)}
                              </span>
                              {cell.validationState !== "NONE" ? <span className="ml-1 text-xs" aria-label="Flagged">⚑</span> : null}
                            </>
                          ) : null}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {preview.totalRows > preview.rows.length ? (
            <p className="text-muted-foreground text-xs">
              Showing {preview.rows.length} of {plural(preview.totalRows, "row")}.
            </p>
          ) : null}
        </>
      )}

      {flagged.length > 0 ? (
        <div className="flex flex-col gap-1 text-sm">
          <p className="font-medium">Flagged cells ({flagged.length})</p>
          <ul className="flex flex-col gap-0.5">
            {flagged.slice(0, 20).map((f, i) => (
              <li key={i}>
                <span className="text-muted-foreground">
                  Row {f.row} · {f.column}:
                </span>{" "}
                {f.cell.validationState === "ERROR" ? "Error: " : "Check: "}
                {f.cell.validationMsgs.join(" ")}
              </li>
            ))}
          </ul>
          {flagged.length > 20 ? <p className="text-muted-foreground text-xs">and {flagged.length - 20} more.</p> : null}
        </div>
      ) : null}

      {preview && preview.flags.filter((f) => f.kind !== "CELLS_FLAGGED").length > 0 ? (
        <div className="flex flex-col gap-1 text-sm">
          <p className="font-medium">Document checks</p>
          <ul className="list-disc pl-5">
            {preview.flags
              .filter((f) => f.kind !== "CELLS_FLAGGED")
              .map((f) => (
                <li key={f.kind}>{f.message}</li>
              ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
