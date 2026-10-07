"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { CreditProblem } from "@/components/account/credit-problem";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { costLine, creditLine, keyLine, photoQualityLine, showsMoney } from "@/lib/ai/cost-lines";
import { AI_MODELS, modelHint, type AIModelId } from "@/lib/ai/models";
import { getJson, postJson } from "@/lib/api-client";
import { plural } from "@/lib/format";
import type { FieldProposalEstimate, FieldProposalView } from "@/lib/templates/field-proposal-schemas";
import { FIELD_TYPE_LABELS } from "@/lib/templates/labels";
import type { TemplateKind } from "@/lib/templates/schemas";

import { FieldName } from "./field-name";

const POLL_MS = 2000;
/** Five minutes of polling; a proposal is one request, so this is far past anything real. */
const MAX_POLLS = 150;
/** Failed polls in a row before giving up. One blip (a dev reload, a dropped connection) must not end the watch. */
const MAX_POLL_FAILURES = 5;
/** Answers that polling again cannot change. */
const FINAL_POLL_ERRORS = new Set(["NOT_FOUND", "UNAUTHORIZED", "VALIDATION"]);

function newNonce(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}-nonce`;
}

const KIND_WORD: Record<TemplateKind, string> = { FORM: "form", TABLE: "table" };
const KIND_ITEMS: Record<TemplateKind, string> = {
  FORM: "each labelled place a value is written, in reading order",
  TABLE: "each column, from its header, left to right",
};

type Stage = "estimate" | "reading" | "proposal";

/**
 * The AI proposes the template (Phase 16, docs/05 §7.3). Estimate in money and the key first, as for
 * extraction; then the page is read in the worker; then a list with a toggle per field and a counted
 * confirmation, the same shape as `Create columns from this template`. Nothing is written until that
 * confirmation, and only the ticked fields are.
 *
 * A proposal has been paid for once it runs, so closing the dialog does not throw it away: reopening
 * on the same page resumes it (`GET …/field-proposals?documentId=`).
 */
export function ProposeFieldsDialog({
  templateId,
  kind,
  documentId,
  documentLabel,
  lang,
  open,
  onOpenChange,
  onAdded,
}: {
  templateId: string;
  kind: TemplateKind;
  documentId: string;
  documentLabel: string | null;
  lang: string | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded: (count: number) => void;
}) {
  const [stage, setStage] = useState<Stage | null>(null);
  const [nonce, setNonce] = useState("");
  const [model, setModel] = useState<AIModelId | null>(null);
  const [estimate, setEstimate] = useState<FieldProposalEstimate | null>(null);
  const [proposal, setProposal] = useState<FieldProposalView | null>(null);
  const [included, setIncluded] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  /** The proposal being read, so `Stop` knows which one. */
  const [readingId, setReadingId] = useState<string | null>(null);
  const base = `/api/templates/${templateId}/field-proposals`;
  const pollToken = useRef(0);

  function showProposal(p: FieldProposalView) {
    setProposal(p);
    setIncluded(new Set(p.items.filter((i) => !i.alreadyInTree).map((i) => i.index)));
    setStage("proposal");
  }

  async function poll(proposalId: string) {
    setReadingId(proposalId);
    const token = ++pollToken.current;
    let failures = 0;
    for (let i = 0; i < MAX_POLLS; i++) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      if (token !== pollToken.current) return;
      const result = await getJson<FieldProposalView>(`${base}/${proposalId}`);
      if (token !== pollToken.current) return;
      if (!result.ok) {
        failures++;
        if (FINAL_POLL_ERRORS.has(result.error.code) || failures >= MAX_POLL_FAILURES) {
          setError(result.error.message);
          return;
        }
        continue;
      }
      failures = 0;
      if (result.data.state === "COMPLETE") {
        showProposal(result.data);
        return;
      }
      if (result.data.state === "FAILED") {
        setError(result.data.error ?? "The AI couldn't read this page.");
        setStage("estimate");
        return;
      }
    }
    setError("Reading this page is taking far longer than it should. Close this and open it again to check on it.");
  }

  // Each opening: resume a proposal of this page if one is waiting, otherwise start from the estimate.
  useEffect(() => {
    if (!open) {
      pollToken.current++;
      setStage(null);
      return;
    }
    setNonce(newNonce());
    setModel(null);
    setEstimate(null);
    setProposal(null);
    setError(null);
    setConfirming(false);
    let cancelled = false;
    void getJson<{ proposal: FieldProposalView | null }>(`${base}?documentId=${documentId}`).then((result) => {
      if (cancelled) return;
      const waiting = result.ok ? result.data.proposal : null;
      if (waiting?.state === "COMPLETE") showProposal(waiting);
      else if (waiting) {
        setStage("reading");
        void poll(waiting.id);
      } else setStage("estimate");
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per opening of this page
  }, [open, documentId]);

  useEffect(() => {
    if (stage !== "estimate" || !nonce) return;
    if (estimate && model === estimate.model) return;
    let cancelled = false;
    void postJson<FieldProposalEstimate>(`${base}/estimate`, { documentId, ...(model ? { model } : {}) }).then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setEstimate(result.data);
      if (!model) setModel(result.data.model as AIModelId);
    });
    return () => {
      cancelled = true;
    };
  }, [stage, nonce, model, estimate, base, documentId]);

  async function start() {
    if (!model || pending) return;
    setPending(true);
    setError(null);
    const result = await postJson<{ id: string }>(base, { documentId, model, nonce });
    setPending(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    // A failed attempt spends this nonce's proposal; asking again is a new proposal.
    setNonce(newNonce());
    setStage("reading");
    void poll(result.data.id);
  }

  /**
   * Stops the reading and goes back to the estimate. If it had already finished, the poll that is still
   * running shows what it finished with, so a result the operator was charged for is never thrown away.
   */
  async function stop() {
    if (!readingId || pending) return;
    setPending(true);
    const result = await postJson<{ stopped: boolean }>(`${base}/${readingId}/stop`, {});
    setPending(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    if (!result.data.stopped) return;
    pollToken.current++;
    setError(null);
    setStage("estimate");
    toast.success("Stopped. Nothing was charged.");
  }

  /** Back to the estimate for a fresh, separately paid proposal; the last one's messages don't carry over. */
  function readAgain() {
    setError(null);
    setStage("estimate");
  }

  async function accept() {
    if (!proposal || pending) return;
    setPending(true);
    const result = await postJson<{ created: number; alreadyAccepted: boolean }>(`${base}/${proposal.id}/accept`, { include: [...included] });
    setPending(false);
    if (!result.ok) {
      setConfirming(false);
      setError(result.error.message);
      return;
    }
    setConfirming(false);
    toast.success(
      result.data.alreadyAccepted
        ? "These fields were already added."
        : `Added ${plural(result.data.created, "field")}. Check each one against the paper.`,
    );
    onOpenChange(false);
    onAdded(result.data.created);
  }

  const items = proposal?.items ?? [];
  const chosen = items.filter((i) => included.has(i.index));
  const left = items.length - chosen.length;
  const reading = stage === "reading";
  const blocked = estimate === null || estimate.providerProblem !== null || estimate.blocker !== null || Boolean(estimate.credits?.problem);

  function toggle(index: number, on: boolean) {
    setIncluded((prev) => {
      const next = new Set(prev);
      if (on) next.add(index);
      else next.delete(index);
      return next;
    });
  }

  return (
    <>
      <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
        <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl" onEscapeKeyDown={(e) => pending && e.preventDefault()}>
          <DialogHeader>
            <DialogTitle>Propose fields from this page</DialogTitle>
            <DialogDescription>
              The AI reads{" "}
              <span lang={lang} className="font-value">
                {documentLabel ?? "this page"}
              </span>{" "}
              as a {KIND_WORD[kind]} and lists {KIND_ITEMS[kind]}. Nothing is added until you choose which to keep. Tick
              sets stay yours to make.
            </DialogDescription>
          </DialogHeader>

          {stage === null ? <p className="text-muted-foreground text-sm">Loading…</p> : null}

          {stage === "estimate" ? (
            <div className="flex flex-col gap-3 text-sm">
              <div className="flex flex-col gap-2">
                <Label htmlFor="propose-model">Model</Label>
                <Select value={model ?? undefined} onValueChange={(v) => setModel(v as AIModelId)} disabled={pending || !model}>
                  <SelectTrigger id="propose-model">
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
                {model ? <p className="text-muted-foreground text-xs">{modelHint(model, Boolean(estimate?.credits))}</p> : null}
              </div>
              {estimate ? (
                <div className="flex flex-col gap-1">
                  <p>
                    {plural(estimate.pages, "photo")}, one request to the model. {costLine(estimate)}
                  </p>
                  {creditLine(estimate) ? <p>{creditLine(estimate)}</p> : null}
                  <p className="text-muted-foreground text-xs">{photoQualityLine(Boolean(estimate.credits))}</p>
                  {showsMoney(estimate.keySource) ? (
                    <p className="text-muted-foreground text-xs">
                      Estimated at the model&apos;s list prices. {keyLine(estimate)}
                    </p>
                  ) : null}
                </div>
              ) : error ? null : (
                <p className="text-muted-foreground">Counting pages…</p>
              )}
              {estimate?.blocker ? <FormMessage tone="error">{estimate.blocker}</FormMessage> : null}
              {estimate?.providerProblem ? <FormMessage tone="error">{estimate.providerProblem}</FormMessage> : null}
              {estimate && !estimate.blocker ? <CreditProblem credits={estimate.credits} /> : null}
            </div>
          ) : null}

          {reading ? (
            <p className="text-muted-foreground text-sm" aria-live="polite" aria-busy="true">
              Reading the page for its fields… You can close this; it keeps going and is here when you come back. Stop
              ends it and charges nothing.
            </p>
          ) : null}

          {stage === "proposal" ? (
            items.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                The AI found no fields on this page. Check the page is the right way up and not blank, read it again with
                another model, or add the fields by hand.
              </p>
            ) : (
              <div className="flex min-h-0 flex-col gap-2">
                <p className="rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-sm">
                  The AI can be confidently wrong, and a wrong list looks finished. Check each label against the paper before
                  you add it — and again in the list afterwards.
                </p>
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-muted-foreground">
                    {chosen.length} of {plural(items.length, "field")} chosen
                  </span>
                  <Button size="sm" variant="ghost" className="ml-auto h-7" onClick={() => setIncluded(new Set(items.map((i) => i.index)))}>
                    Choose all
                  </Button>
                  <Button size="sm" variant="ghost" className="h-7" onClick={() => setIncluded(new Set())}>
                    Choose none
                  </Button>
                </div>
                <ul className="min-h-0 flex-1 overflow-y-auto rounded-md border text-sm" aria-label="Proposed fields in paper order">
                  {items.map((item) => {
                    const id = `proposed-${item.index}`;
                    return (
                      <li key={item.index} className="flex items-start gap-3 border-b px-3 py-2 last:border-b-0">
                        <Checkbox
                          id={id}
                          className="mt-0.5"
                          checked={included.has(item.index)}
                          onCheckedChange={(v) => toggle(item.index, v === true)}
                        />
                        <label htmlFor={id} className="flex min-w-0 flex-1 flex-col gap-0.5">
                          <span className="flex items-baseline gap-2">
                            <FieldName name={item.labelSource} lang={lang} className="min-w-0 font-medium" />
                            {item.labelMeaning ? <span className="text-muted-foreground min-w-0 break-words">{item.labelMeaning}</span> : null}
                          </span>
                          {item.choices.length > 0 ? (
                            <span lang={lang} className="font-value text-muted-foreground truncate text-xs">
                              {item.choices.join(" · ")}
                            </span>
                          ) : null}
                          {item.note ? <span className="text-muted-foreground truncate text-xs">{item.note}</span> : null}
                          {item.alreadyInTree ? <span className="text-muted-foreground text-xs">Already in the list</span> : null}
                        </label>
                        <Badge variant="outline" className="shrink-0">
                          {FIELD_TYPE_LABELS[item.dataType]}
                        </Badge>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )
          ) : null}

          {error ? <FormMessage tone="error">{error}</FormMessage> : null}

          <DialogFooter>
            <Button variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>
              {reading ? "Close" : "Cancel"}
            </Button>
            {reading ? (
              <Button variant="outline" disabled={pending || !readingId} onClick={() => void stop()}>
                {pending ? "Stopping…" : "Stop"}
              </Button>
            ) : null}
            {stage === "estimate" ? (
              <Button disabled={blocked || !model || pending} onClick={() => void start()}>
                {pending ? "Starting…" : "Propose fields"}
              </Button>
            ) : null}
            {stage === "proposal" && items.length > 0 ? (
              <>
                <Button variant="ghost" disabled={pending} onClick={readAgain}>
                  Read again
                </Button>
                <Button disabled={chosen.length === 0 || pending} onClick={() => setConfirming(true)}>
                  Add {plural(chosen.length, "field")}
                </Button>
              </>
            ) : null}
            {stage === "proposal" && items.length === 0 ? (
              <Button variant="ghost" onClick={readAgain}>
                Read again
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirming} onOpenChange={(next) => !pending && setConfirming(next)}>
        <AlertDialogContent onEscapeKeyDown={(e) => pending && e.preventDefault()}>
          <AlertDialogHeader>
            <AlertDialogTitle>Adds {plural(chosen.length, "field")}</AlertDialogTitle>
            <AlertDialogDescription>
              At the end of the list, in paper order, each set to Extract.{" "}
              {left > 0 ? `${plural(left, "proposed field")} ${left === 1 ? "is" : "are"} left out and won't be created.` : "Every proposed field is included."}{" "}
              Nothing is read again and no further AI cost is involved.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ul className="max-h-64 overflow-y-auto rounded-md border text-sm" aria-label="Fields to add">
            {chosen.map((item) => (
              <li key={item.index} className="flex items-baseline justify-between gap-3 border-b px-3 py-1.5 last:border-b-0">
                <FieldName name={item.labelSource} lang={lang} className="min-w-0" />
                <span className="text-muted-foreground shrink-0 text-xs">{FIELD_TYPE_LABELS[item.dataType]}</span>
              </li>
            ))}
          </ul>
          <AlertDialogFooter>
            <AlertDialogCancel type="button" disabled={pending}>
              Cancel
            </AlertDialogCancel>
            <Button type="button" onClick={() => void accept()} disabled={pending}>
              {pending ? "Adding…" : `Add ${plural(chosen.length, "field")}`}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
