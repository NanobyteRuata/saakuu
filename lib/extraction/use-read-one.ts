"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { getJson, postJson } from "@/lib/api-client";
import { ACTIVE_RUN_STATES } from "@/lib/documents/schemas";
import type { DocumentDetail, DocumentRawValues } from "@/lib/documents/service";

import type { ExtractionEstimate, ExtractionStatus } from "./service";

/**
 * Reading one page and showing what came back (Phase 10, moved to the front in Phase 15).
 *
 * It is not a pipeline of its own: it is the normal extraction of one document and the raw layer
 * that reading writes. It lives in a hook because two surfaces drive it now — the `Try one document`
 * dialog, and the template workspace, where the page is already on screen in its own pane and a
 * modal would only cover it up.
 */
const POLL_MS = 2000;
/** Processing a page and reading it are both slow; give up explaining rather than spinning for ever. */
const MAX_WAIT_MS = 5 * 60 * 1000;

export type ReadStage = "idle" | "processing" | "extracting" | "done";

export const READ_STAGE_LABEL: Record<Exclude<ReadStage, "idle" | "done">, string> = {
  processing: "Preparing the photo…",
  extracting: "Reading the page…",
};

export type ReadOne = {
  stage: ReadStage;
  error: string | null;
  /** The document being read, refreshed once the reading lands. */
  detail: DocumentDetail | null;
  raw: DocumentRawValues | null;
  read: (documentId: string) => Promise<void>;
  /** Picks up a reading this document already has, or one still running, without starting a new one. */
  resume: (documentId: string) => Promise<void>;
  reset: () => void;
  setError: (message: string | null) => void;
};

const RUN_FAILED = "The page couldn't be read. The Documents tab can retry it.";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Check = () => Promise<"done" | "waiting" | { problem: string }>;

export function useReadOne(onRead?: () => void): ReadOne {
  const [stage, setStage] = useState<ReadStage>("idle");
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<DocumentDetail | null>(null);
  const [raw, setRaw] = useState<DocumentRawValues | null>(null);
  const cancelled = useRef(false);
  /** Each read or resume supersedes the last, so a slow poll for one page never lands on another. */
  const generation = useRef(0);
  const onReadRef = useRef(onRead);
  onReadRef.current = onRead;

  useEffect(() => {
    cancelled.current = false;
    return () => {
      cancelled.current = true;
    };
  }, []);

  /** Starts a new attempt, clearing the last one; the returned check is true once it is superseded. */
  const begin = useCallback(() => {
    const mine = ++generation.current;
    setError(null);
    setRaw(null);
    return () => cancelled.current || generation.current !== mine;
  }, []);

  const fail = useCallback((message: string) => {
    setError(message);
    setStage("idle");
  }, []);

  /**
   * Polls until the check says the step is done, or gives up with a message the operator can act on.
   * The check answers "done" / "keep waiting" / "give up, with this reason": a state update made
   * inside it is not visible to this loop, so the reason has to travel back through the result.
   */
  const waitFor = useCallback(
    async (stale: () => boolean, check: Check, timedOut: string): Promise<boolean> => {
      const until = Date.now() + MAX_WAIT_MS;
      for (;;) {
        if (stale()) return false;
        const state = await check();
        if (stale()) return false;
        if (state === "done") return true;
        if (state !== "waiting") {
          fail(state.problem);
          return false;
        }
        if (Date.now() > until) {
          fail(timedOut);
          return false;
        }
        await sleep(POLL_MS);
      }
    },
    [fail],
  );

  /** Waits out the document's run. Only a finished state counts. */
  const waitForRun = useCallback(
    (stale: () => boolean, documentId: string) =>
      waitFor(
        stale,
        async () => {
          const result = await getJson<ExtractionStatus[]>(`/api/extractions/status?documentIds=${documentId}`);
          const status = result.ok ? result.data[0] : undefined;
          if (status === undefined) return "waiting";
          if (status.runState === "FAILED") return { problem: RUN_FAILED };
          return status.runState === "COMPLETE" || status.runState === "PARTIAL" ? "done" : "waiting";
        },
        "The reading is taking longer than usual. It will finish on the Documents tab.",
      ),
    [waitFor],
  );

  /** Fetches what the document's latest run read and shows it. */
  const show = useCallback(
    async (stale: () => boolean, documentId: string, notify: boolean) => {
      const [values, fresh] = await Promise.all([
        getJson<DocumentRawValues>(`/api/documents/${documentId}/raw`),
        getJson<DocumentDetail>(`/api/documents/${documentId}`),
      ]);
      if (stale()) return;
      if (!values.ok) return fail(values.error.message);
      if (fresh.ok) setDetail(fresh.data);
      setRaw(values.data);
      setStage("done");
      if (notify) onReadRef.current?.();
    },
    [fail],
  );

  /** Waits for the pages to be ready, reads the document, then keeps what came back. */
  const read = useCallback(
    async (documentId: string) => {
      const stale = begin();
      setStage("processing");
      const ready = await waitFor(
        stale,
        async () => {
          const result = await getJson<DocumentDetail>(`/api/documents/${documentId}`);
          if (!result.ok) return "waiting";
          const photos = result.data.photos;
          const failed = photos.find((p) => p.status === "FAILED");
          if (failed) return { problem: failed.errorMessage ?? "That page couldn't be processed. Try a different photo." };
          if (!stale()) setDetail(result.data);
          return photos.length > 0 && photos.every((p) => p.status === "DONE" && p.workingUrl !== null) ? "done" : "waiting";
        },
        "The photo is taking longer than usual to prepare. It will appear on the Documents tab when it's ready.",
      );
      if (!ready) return;

      setStage("extracting");
      /*
       * The estimate costs nothing and is also the gate: a template with no fields set to Extract is
       * refused here, in the server's own words, so nothing is ever spent on a template that has
       * nothing to ask for (Phase 15).
       */
      const estimate = await postJson<ExtractionEstimate>("/api/extractions/estimate", { documentIds: [documentId] });
      if (stale()) return;
      if (!estimate.ok) return fail(estimate.error.message);
      if (estimate.data.providerProblem !== null) return fail(estimate.data.providerProblem);
      if (estimate.data.extractable === 0) {
        return fail(estimate.data.blockers[0]?.reason ?? "This document can't be read right now.");
      }

      const started = await postJson<{ queued: number }>("/api/extractions/start", {
        documentIds: [documentId],
        model: estimate.data.model,
        nonce: crypto.randomUUID(),
      });
      if (stale()) return;
      if (!started.ok) return fail(started.error.message);

      // `NEVER_RUN` is still waiting: the poll can outrun the run row this document was just given,
      // and reading its raw values then shows an empty page.
      if (!(await waitForRun(stale, documentId))) return;
      await show(stale, documentId, true);
    },
    [begin, fail, waitFor, waitForRun, show],
  );

  /*
   * The run lives on the server, the progress only in this hook: after a reload the page would
   * otherwise show nothing, and pressing the button again would pay for a reading that exists.
   */
  const resume = useCallback(
    async (documentId: string) => {
      const stale = begin();
      setDetail(null);
      setStage("idle");
      const result = await getJson<ExtractionStatus[]>(`/api/extractions/status?documentIds=${documentId}`);
      if (stale()) return;
      if (!result.ok) return fail(result.error.message);
      const runState = result.data[0]?.runState;
      if (runState === undefined) return;
      if (runState === "FAILED") return fail(RUN_FAILED);
      if (ACTIVE_RUN_STATES.includes(runState)) {
        setStage("extracting");
        if (!(await waitForRun(stale, documentId))) return;
        await show(stale, documentId, true);
      } else if (runState === "COMPLETE" || runState === "PARTIAL") {
        await show(stale, documentId, false);
      }
    },
    [begin, fail, waitForRun, show],
  );

  const reset = useCallback(() => {
    generation.current++;
    setStage("idle");
    setError(null);
    setDetail(null);
    setRaw(null);
  }, []);

  return { stage, error, detail, raw, read, resume, reset, setError };
}
