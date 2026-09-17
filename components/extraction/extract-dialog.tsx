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
import { AI_MODELS, type AIModelId } from "@/lib/ai/models";
import { postJson } from "@/lib/api-client";
import type { ExtractionEstimate, StartResult } from "@/lib/extraction/service";
import { formatCount, plural } from "@/lib/format";

export type ExtractTarget = { documentIds: string[] } | { templateId: string };

type Props = {
  target: ExtractTarget | null;
  /** "Extract" or "Re-extract". */
  verb?: string;
  onOpenChange: (open: boolean) => void;
  onStarted: () => void;
};

function newNonce(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}-nonce`;
}

function aboutTime(seconds: number): string {
  if (seconds < 60) return "under a minute";
  const minutes = Math.round(seconds / 60);
  return minutes < 90 ? `about ${plural(minutes, "minute")}` : `about ${plural(Math.round(minutes / 60), "hour")}`;
}

/**
 * Extract modal (docs/05 §11): model, counts, estimate, warnings. One nonce per opening is sent with
 * every submit, so a double click or a retried request starts the extraction only once.
 */
export function ExtractDialog({ target, verb = "Extract", onOpenChange, onStarted }: Props) {
  const open = target !== null;
  const [nonce, setNonce] = useState("");
  const [model, setModel] = useState<AIModelId | null>(null);
  const [estimate, setEstimate] = useState<ExtractionEstimate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const targetKey = target ? JSON.stringify(target) : "";

  useEffect(() => {
    if (!open) {
      setNonce("");
      return;
    }
    setNonce(newNonce());
    setModel(null);
    setEstimate(null);
    setError(null);
  }, [open, targetKey]);

  useEffect(() => {
    // Wait until this opening has been reset (it sets the nonce), and don't refetch when the model was
    // only prefilled from the estimate that just arrived.
    if (!targetKey || !nonce) return;
    if (estimate && model === estimate.model) return;
    let cancelled = false;
    setError(null);
    const body = { ...(JSON.parse(targetKey) as ExtractTarget), ...(model ? { model } : {}) };
    void postJson<ExtractionEstimate>("/api/extractions/estimate", body).then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setEstimate(result.data);
      if (!model) setModel(result.data.model);
    });
    return () => {
      cancelled = true;
    };
  }, [targetKey, nonce, model, estimate, attempt]);

  async function confirm() {
    if (!target || !model || !estimate || pending) return;
    setPending(true);
    const result = await postJson<StartResult>("/api/extractions/start", { ...target, model, nonce });
    setPending(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    const { queued, alreadyStarted, skipped } = result.data;
    if (queued > 0) toast.success(`Extracting ${plural(queued, "document")}. Progress shows in the list.`);
    else if (alreadyStarted > 0) toast.success("This extraction was already started.");
    if (skipped.length > 0) toast.warning(`${plural(skipped.length, "document")} skipped: ${skipped[0]?.reason ?? ""}`);
    onOpenChange(false);
    onStarted();
  }

  const loading = open && !estimate && !error;

  return (
    <AlertDialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <AlertDialogContent onEscapeKeyDown={(e) => pending && e.preventDefault()}>
        <AlertDialogHeader>
          <AlertDialogTitle>{verb} with AI</AlertDialogTitle>
          <AlertDialogDescription>
            The AI reads each page and writes down exactly what it sees. You check every value afterwards.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="flex flex-col gap-2">
          <Label htmlFor="extract-model">Model</Label>
          <Select value={model ?? undefined} onValueChange={(v) => setModel(v as AIModelId)} disabled={pending || !model}>
            <SelectTrigger id="extract-model">
              <SelectValue placeholder="Loading…" />
            </SelectTrigger>
            <SelectContent>
              {AI_MODELS.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {model ? <p className="text-muted-foreground text-xs">{AI_MODELS.find((m) => m.id === model)?.description}</p> : null}
        </div>

        {loading ? <p className="text-muted-foreground text-sm">Counting pages…</p> : null}
        {estimate ? (
          <div className="flex flex-col gap-3 text-sm">
            <p>
              {plural(estimate.extractable, "document")} · {plural(estimate.pages, "page")} · {plural(estimate.requests, "request")} to the
              model. Roughly {formatCount(Math.round(estimate.estInputTokens / 100) * 100)} input tokens, {aboutTime(estimate.estSeconds)}.
            </p>
            {estimate.warnings.length > 0 ? (
              <ul className="flex list-disc flex-col gap-1 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 pl-7" aria-label="Warnings">
                {estimate.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            ) : null}
            {estimate.blockers.length > 0 ? (
              <div className="border-destructive/40 bg-destructive/5 flex flex-col gap-1 rounded-md border p-3">
                <p className="font-medium">
                  {plural(estimate.blockers.length, "document")} can&apos;t be extracted now and will be skipped:
                </p>
                <ul className="list-disc pl-5">
                  {estimate.blockers.slice(0, 8).map((b) => (
                    <li key={b.documentId}>
                      <span lang="my" className="font-value">
                        {b.label ?? "Untitled document"}
                      </span>
                      : {b.reason}
                    </li>
                  ))}
                  {estimate.blockers.length > 8 ? <li>and {plural(estimate.blockers.length - 8, "more document")}</li> : null}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}
        {estimate?.providerProblem ? <FormMessage tone="error">{estimate.providerProblem}</FormMessage> : null}
        {error ? (
          <div className="flex flex-col items-start gap-2">
            <FormMessage tone="error">{error}</FormMessage>
            {!estimate ? (
              <Button type="button" variant="outline" size="sm" onClick={() => setAttempt((n) => n + 1)}>
                Try again
              </Button>
            ) : null}
          </div>
        ) : null}

        <AlertDialogFooter>
          <AlertDialogCancel type="button" disabled={pending}>
            Cancel
          </AlertDialogCancel>
          <Button type="button" onClick={confirm} disabled={!estimate || !model || estimate.extractable === 0 || estimate.providerProblem !== null || pending}>
            {pending ? "Starting…" : `${verb} ${plural(estimate?.extractable ?? 0, "document")}`}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
