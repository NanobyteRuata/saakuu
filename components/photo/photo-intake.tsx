"use client";

import { Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { FormMessage } from "@/components/auth/form-message";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { postJson } from "@/lib/api-client";
import { plural } from "@/lib/format";
import { UPLOAD_MIME_TYPES } from "@/lib/photos/schemas";
import { UPLOAD_ACCEPT, useIntakeUploads } from "@/lib/photos/use-intake-uploads";
import type { PhotoView } from "@/lib/photos/views";
import type { TemplateKind } from "@/lib/templates/schemas";
import { cn } from "@/lib/utils";

import { BatchIntake } from "./batch-intake";

export type TemplateOption = { id: string; name: string; kind: TemplateKind };

/** Replacing refuses PDFs server-side too: a PDF is an import of several pages, not one page. */
const REPLACE_TYPES = UPLOAD_MIME_TYPES.filter((m) => m !== "application/pdf");

export type PageUploadTarget =
  | { kind: "replace"; photoId: string; page: number; rows: number; editedCells: number; reviewed: boolean }
  | { kind: "add" };

/**
 * The four ways a photo gets into the product (Phase 15).
 *
 * They used to be three components that looked nothing alike, two of which a first-time operator met
 * within ten minutes, with three different upload implementations underneath. They are one component
 * now: the mode decides what an uploaded key becomes and what is shown afterwards, and everything
 * else — the picker, the drop zone, the size and type rules, progress, abort, the error line — is
 * the same code in all four.
 */
export type IntakeMode =
  /** Documents workspace: many files, each its own document, staged for grouping. */
  | { kind: "batch"; templates: TemplateOption[]; initialTemplateId: string | null; lockTemplate?: boolean }
  /** Template workspace: the page the template is being built against (decision 71). */
  | { kind: "specimen"; templateId: string; templateName: string }
  /** One page to read now, either newly uploaded or one already in the book. */
  | { kind: "try"; templateId: string; templateName: string }
  /** Re-shooting a page, or adding one to a document photographed incompletely (Phase 11). */
  | { kind: "page"; templateId: string; documentId: string; documentLabel: string | null; target: PageUploadTarget };

export type IntakeResult =
  | { kind: "batch" }
  /** A new document: the specimen just uploaded, or the page to read. */
  | { kind: "document"; documentId: string }
  | { kind: "photo"; photo: PhotoView };

type Props = {
  mode: IntakeMode;
  onDone: (result: IntakeResult) => void;
  /** Uploads in flight: the dialog wrapper asks before closing on these. */
  onBusyChange?: (unfinished: number) => void;
};

/**
 * Exact counts of what a replace keeps, per the confirmation rule in CLAUDE.md. What it keeps *is*
 * the point of the feature (decision 59).
 */
function keptSentence(target: Extract<PageUploadTarget, { kind: "replace" }>): string {
  if (target.rows === 0) return "This document has no rows yet, so there is nothing to keep.";
  const kept = [plural(target.rows, "row")];
  if (target.editedCells > 0) kept.push(`${plural(target.editedCells, "cell")} you edited`);
  const subject = kept.length === 1 ? kept[0] : `${kept.slice(0, -1).join(", ")} and ${kept.at(-1)}`;
  const verb = kept.length === 1 && target.rows === 1 ? "is" : "are";
  return `Its ${subject} ${verb} kept${target.reviewed ? ", and so are your reviewed marks" : ""}.`;
}

/** The drop zone every mode shares. Single-file modes render it compact. */
export function Dropzone({
  onFiles,
  accept,
  multiple,
  disabled = false,
  compact = false,
  title,
  hint,
  inputRef,
}: {
  onFiles: (files: FileList | File[]) => void;
  accept: string;
  multiple: boolean;
  disabled?: boolean;
  compact?: boolean;
  title: string;
  hint: string;
  inputRef: React.RefObject<HTMLInputElement | null>;
}) {
  const [dragOver, setDragOver] = useState(false);
  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled}
      aria-label={title}
      onClick={() => !disabled && inputRef.current?.click()}
      onKeyDown={(e) => {
        if (!disabled && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          inputRef.current?.click();
        }
      }}
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        if (!disabled) onFiles(e.dataTransfer.files);
      }}
      className={cn(
        "focus-visible:ring-ring/50 flex flex-col items-center gap-2 rounded-xl border-2 border-dashed px-6 text-center outline-none focus-visible:ring-[3px]",
        compact ? "py-5" : "py-10",
        disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer",
        dragOver && "border-primary bg-primary/5",
      )}
    >
      <Upload className="text-muted-foreground size-6" />
      <p className="font-medium">{title}</p>
      <p className="text-muted-foreground text-sm">{hint}</p>
      <input
        ref={inputRef}
        type="file"
        multiple={multiple}
        hidden
        accept={accept}
        onChange={(e) => {
          if (e.target.files) onFiles(e.target.files);
          e.target.value = "";
        }}
      />
    </div>
  );
}

/** Specimen, try and replace/add: one file, one thing created, one progress line. */
function SingleIntake({ mode, onDone, onBusyChange }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const templateId = mode.kind === "batch" ? null : mode.templateId;
  const replacing = mode.kind === "page" && mode.target.kind === "replace";

  const intake = useIntakeUploads<IntakeResult>({
    templateId,
    parallel: 1,
    accept: replacing ? REPLACE_TYPES : UPLOAD_MIME_TYPES,
    register: async ({ key, file }) => {
      if (mode.kind === "page") {
        const url = mode.target.kind === "replace" ? `/api/photos/${mode.target.photoId}/replace` : `/api/documents/${mode.documentId}/pages`;
        const result = await postJson<{ photo: PhotoView }>(url, { key, filename: file.name });
        return result.ok ? { ok: true as const, data: { kind: "photo" as const, photo: result.data.photo } } : result;
      }
      const result = await postJson<{ documentId: string }>("/api/uploads/complete", {
        key,
        templateId,
        filename: file.name,
        // A specimen is born one, so there is never a moment where it counts as an ordinary document.
        ...(mode.kind === "specimen" ? { isSpecimen: true } : {}),
      });
      return result.ok ? { ok: true as const, data: { kind: "document" as const, documentId: result.data.documentId } } : result;
    },
    onRegistered: (result) => {
      if (result.kind === "photo" && mode.kind === "page") {
        toast.success(
          mode.target.kind === "replace"
            ? `Page ${mode.target.page} replaced. Extract this document again to read the new photo.`
            : "Page added. Extract this document again to read it.",
        );
      }
      onDone(result);
    },
  });

  const busy = intake.unfinished > 0;
  useEffect(() => onBusyChange?.(intake.unfinished), [intake.unfinished, onBusyChange]);

  const file = intake.files.at(-1);
  const accept = (replacing ? REPLACE_TYPES : UPLOAD_MIME_TYPES).join(",");

  return (
    <div className="flex flex-col gap-3">
      {mode.kind === "page" && mode.target.kind === "replace" ? (
        <div className="text-sm">
          <p>{keptSentence(mode.target)}</p>
          <p className="text-muted-foreground mt-1">
            The document is then marked <span className="text-foreground">Changed since last read</span>. Extract it again to
            read the new photo — your edits are kept and a new reading that differs is flagged instead of replacing them.
          </p>
        </div>
      ) : null}
      {mode.kind === "page" && mode.target.kind === "add" ? (
        <p className="text-muted-foreground text-sm">
          The document is marked <span className="text-foreground">Changed since last read</span> so you can find it again.
          Extract it to read the new page.
        </p>
      ) : null}

      <Dropzone
        inputRef={inputRef}
        onFiles={intake.addFiles}
        accept={mode.kind === "page" ? accept : UPLOAD_ACCEPT}
        multiple={false}
        disabled={busy}
        compact={mode.kind === "page"}
        title={busy ? "Uploading…" : "Drop a photo here, or click to choose one"}
        hint={
          replacing
            ? "JPEG, PNG, WebP or HEIC, up to 25 MB. A PDF is several pages, so use Upload documents for one."
            : "JPEG, PNG, WebP, HEIC or PDF, up to 25 MB."
        }
      />

      {busy && file ? (
        <p className="text-muted-foreground text-sm" aria-live="polite">
          Uploading… {Math.round(file.progress * 100)}%
        </p>
      ) : null}
      {intake.error ? <FormMessage tone="error">{intake.error}</FormMessage> : null}
      {file?.phase === "failed" && file.error ? <FormMessage tone="error">{file.error}</FormMessage> : null}
    </div>
  );
}

/**
 * One photo intake in four modes (docs/05 §9). Renders the contents only, so the template workspace
 * can put it straight in a pane while the other entry points wrap it in `PhotoIntakeDialog`.
 */
export function PhotoIntake(props: Props) {
  if (props.mode.kind === "batch") {
    return <BatchIntake mode={props.mode} onDone={props.onDone} onBusyChange={props.onBusyChange} />;
  }
  return <SingleIntake {...props} />;
}

const TITLES: Record<IntakeMode["kind"], string> = {
  batch: "Upload documents",
  specimen: "Add the page you're working from",
  try: "Read one page",
  page: "Add a page",
};

/** The dialog wrapper, and the one guard that only matters with uploads in flight. */
export function PhotoIntakeDialog({
  mode,
  open,
  onOpenChange,
  onDone,
  onClosed,
  description,
  children,
}: {
  mode: IntakeMode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** What the intake produced. The dialog closes itself afterwards. */
  onDone?: (result: IntakeResult) => void;
  /** The dialog closed; things may have been created while it was open. */
  onClosed?: () => void;
  description?: string;
  /** Rendered under the intake, e.g. the list of pages already uploaded. */
  children?: React.ReactNode;
}) {
  const unfinishedRef = useRef(0);
  const [confirmLeave, setConfirmLeave] = useState<number | null>(null);
  const batch = mode.kind === "batch";
  const title = mode.kind === "page" && mode.target.kind === "replace" ? `Replace page ${mode.target.page}` : TITLES[mode.kind];

  function close() {
    onOpenChange(false);
    onClosed?.();
  }

  /** Leaving by the X, Escape or the backdrop: uploads still running are worth asking about. */
  function requestClose(next: boolean) {
    if (next) return onOpenChange(true);
    if (unfinishedRef.current > 0) {
      setConfirmLeave(unfinishedRef.current);
      return;
    }
    close();
  }

  /**
   * Closing because the work finished. It cannot go through `requestClose`: the intake reports a
   * finished file synchronously, one render before the `unfinished` count it drives has committed,
   * so the guard would see the upload that just succeeded as one still in flight and ask whether to
   * abandon it.
   */
  function closeAfterWork() {
    unfinishedRef.current = 0;
    close();
  }

  return (
    <>
      <Dialog open={open} onOpenChange={requestClose}>
        <DialogContent
          className={cn("flex flex-col gap-4", batch ? "h-[calc(100vh-2rem)] max-w-[calc(100%-2rem)] sm:max-w-6xl" : "sm:max-w-2xl")}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description ? <DialogDescription>{description}</DialogDescription> : null}
          </DialogHeader>
          {open ? (
            <PhotoIntake
              mode={mode}
              onDone={(result) => {
                onDone?.(result);
                closeAfterWork();
              }}
              onBusyChange={(n) => {
                unfinishedRef.current = n;
              }}
            />
          ) : null}
          {children}
        </DialogContent>
      </Dialog>
      <AlertDialog open={confirmLeave !== null} onOpenChange={(next) => !next && setConfirmLeave(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop uploading?</AlertDialogTitle>
            <AlertDialogDescription>
              {plural(confirmLeave ?? 0, "file")} {confirmLeave === 1 ? "hasn't" : "haven't"} finished uploading. Leaving now
              stops {confirmLeave === 1 ? "it" : "them"}. Files that already finished stay as documents.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep uploading</AlertDialogCancel>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmLeave(null);
                unfinishedRef.current = 0;
                close();
              }}
            >
              Stop and close
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
