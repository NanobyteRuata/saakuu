"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { Result } from "@/lib/errors";

import { MAX_UPLOAD_BYTES, mimeTypeFromFilename, UPLOAD_MIME_TYPES } from "./schemas";
import { uploadMimeType, uploadToStorage } from "./upload-client";

/**
 * The one upload path behind every photo intake (Phase 15).
 *
 * Before this there were three: an inline XHR in the batch dialog, `uploadToStorage` in the
 * replace/add dialog, and a bare `fetch` in `Try one document` with no progress and no way to
 * abort. They also carried three copies of the same size and type rules, which had already drifted.
 * Everything specific to a mode lives in `register`: what the key becomes — a new document, a
 * specimen, a re-shot page, an appended page — is the only real difference between them.
 */
export const PARALLEL_UPLOADS = 4;

/** Files listed in the browser's picker. Mime types alone hide HEIC, which browsers report as "". */
export const UPLOAD_ACCEPT = ".jpg,.jpeg,.png,.webp,.heic,.heif,.pdf,image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf";

export type IntakePhase = "waiting" | "uploading" | "registering" | "uploaded" | "failed";

export type IntakeFile = {
  localId: string;
  name: string;
  size: number;
  progress: number;
  phase: IntakePhase;
  error: string | null;
};

/** The one place the upload rules are worded, so every entry point refuses the same files alike. */
export function fileProblem(file: File, accept: readonly string[] = UPLOAD_MIME_TYPES): string | null {
  const mime = mimeTypeFromFilename(file.name) ?? file.type;
  if (!(accept as readonly string[]).includes(mime)) {
    // Worded from what this picker takes, not from which array was passed: an equal-but-copied list
    // would otherwise promise PDFs on a picker that refuses them.
    return accept.includes("application/pdf")
      ? "only JPEG, PNG, WebP, HEIC and PDF files can be uploaded."
      : "only JPEG, PNG, WebP and HEIC photos can be used here.";
  }
  if (file.size > MAX_UPLOAD_BYTES) return "files can be at most 25 MB.";
  if (file.size === 0) return "this file is empty.";
  return null;
}

type Options<T> = {
  /** Null disables picking: the batch dialog waits until a template is chosen. */
  templateId: string | null;
  /** Turns an uploaded key into whatever this mode creates. */
  register: (args: { key: string; file: File }) => Promise<Result<T>>;
  /** Called once per file that registered, in the order the files were picked. */
  onRegistered?: (value: T, file: File) => void;
  /** Types this mode takes; defaults to everything the server accepts. Replace refuses PDFs. */
  accept?: readonly string[];
  /** Uploads at once. Single-file modes leave it at 1 so their progress bar means one thing. */
  parallel?: number;
};

type Intake = {
  files: IntakeFile[];
  addFiles: (list: FileList | File[]) => void;
  /** Files picked that have not finished: closing on these asks first, and stops them. */
  unfinished: number;
  error: string | null;
  setError: (message: string | null) => void;
  reset: () => void;
};

export function useIntakeUploads<T>({ templateId, register, onRegistered, accept = UPLOAD_MIME_TYPES, parallel = PARALLEL_UPLOADS }: Options<T>): Intake {
  const [files, setFiles] = useState<IntakeFile[]>([]);
  const [error, setError] = useState<string | null>(null);

  const queueRef = useRef<{ item: IntakeFile; file: File; previous: Promise<void>; settle: () => void }[]>([]);
  const activeRef = useRef(0);
  /*
   * Registration runs in the order the files were picked, so documents take their positions — the
   * book's manual order — in that order even though the bytes go up in parallel.
   */
  const chainRef = useRef<Promise<void>>(Promise.resolve());
  const xhrsRef = useRef(new Set<XMLHttpRequest>());
  const stoppedRef = useRef(false);
  const registerRef = useRef(register);
  const onRegisteredRef = useRef(onRegistered);
  registerRef.current = register;
  onRegisteredRef.current = onRegistered;

  /*
   * Unmounting stops unfinished uploads; files that never registered never become anything. The flag
   * is reset on (re)mount because Strict Mode runs this cleanup once before the real mount.
   */
  useEffect(() => {
    const xhrs = xhrsRef.current;
    stoppedRef.current = false;
    return () => {
      stoppedRef.current = true;
      queueRef.current = [];
      for (const xhr of xhrs) xhr.abort();
    };
  }, []);

  const patch = useCallback((localId: string, next: Partial<IntakeFile>) => {
    setFiles((prev) => prev.map((f) => (f.localId === localId ? { ...f, ...next } : f)));
  }, []);

  const trackXhr = useCallback((xhr: XMLHttpRequest) => {
    xhrsRef.current.add(xhr);
    return () => xhrsRef.current.delete(xhr);
  }, []);

  const uploadOne = useCallback(
    async (forTemplate: string, item: IntakeFile, file: File, previous: Promise<void>) => {
      if (stoppedRef.current) return;
      patch(item.localId, { phase: "uploading" });
      let stored;
      try {
        stored = await uploadToStorage(forTemplate, file, (progress) => patch(item.localId, { progress }), trackXhr);
      } catch {
        patch(item.localId, { phase: "failed", error: "The upload was interrupted. Check your connection and try again." });
        return;
      }
      if (!stored.ok) {
        patch(item.localId, { phase: "failed", error: stored.error.message });
        return;
      }
      patch(item.localId, { phase: "registering", progress: 1 });
      await previous;
      if (stoppedRef.current) return;
      const registered = await registerRef.current({ key: stored.data.key, file });
      if (!registered.ok) {
        patch(item.localId, { phase: "failed", error: registered.error.message });
        return;
      }
      patch(item.localId, { phase: "uploaded" });
      onRegisteredRef.current?.(registered.data, file);
    },
    [patch, trackXhr],
  );

  const pump = useCallback(
    (forTemplate: string) => {
      while (activeRef.current < parallel && queueRef.current.length > 0) {
        const next = queueRef.current.shift();
        if (!next) break;
        activeRef.current += 1;
        void uploadOne(forTemplate, next.item, next.file, next.previous).finally(() => {
          next.settle();
          activeRef.current -= 1;
          pump(forTemplate);
        });
      }
    },
    [parallel, uploadOne],
  );

  const addFiles = useCallback(
    (list: FileList | File[]) => {
      if (!templateId) return;
      setError(null);
      const accepted: { item: IntakeFile; file: File }[] = [];
      const rejected: string[] = [];
      for (const file of Array.from(list)) {
        const problem = fileProblem(file, accept);
        const item: IntakeFile = { localId: crypto.randomUUID(), name: file.name, size: file.size, progress: 0, phase: "waiting", error: null };
        if (problem) rejected.push(`${file.name}: ${problem}`);
        else accepted.push({ item, file });
      }
      if (rejected.length > 0) setError(rejected.join(" "));
      setFiles((prev) => [...prev, ...accepted.map((a) => a.item)]);
      for (const a of accepted) {
        // A file registers once the previously picked file has settled, forming a chain in pick order.
        const previous = chainRef.current;
        let settle: () => void = () => undefined;
        chainRef.current = new Promise<void>((resolve) => {
          settle = resolve;
        });
        queueRef.current.push({ ...a, previous, settle });
      }
      pump(templateId);
    },
    [accept, pump, templateId],
  );

  const reset = useCallback(() => {
    setFiles([]);
    setError(null);
  }, []);

  return {
    files,
    addFiles,
    unfinished: files.filter((f) => f.phase === "waiting" || f.phase === "uploading" || f.phase === "registering").length,
    error,
    setError,
    reset,
  };
}

export { uploadMimeType };
