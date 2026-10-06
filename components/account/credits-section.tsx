"use client";

import { useState } from "react";
import { toast } from "sonner";

import { FormMessage } from "@/components/auth/form-message";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { creditRequestSchema } from "@/lib/account/schemas";
import { getJson, postJson } from "@/lib/api-client";
import { creditCount, formatCredits } from "@/lib/credits/rate";
import type { CreditAccount, CreditEntryView } from "@/lib/credits/service";
import { isoDate, plural } from "@/lib/format";

/**
 * Credits (Phase 22, decision 81): what is left, what readings have used, and how to ask for more.
 * Credits, never money — on the deployment's key the figure behind them is its cost, not a price.
 */

const KIND_LABEL: Record<CreditEntryView["kind"], string> = {
  SIGNUP: "Free credits for a new account",
  GRANT: "Added for you",
  PURCHASE: "Bought",
  USAGE: "Reading",
};

function entryLabel(entry: CreditEntryView): string {
  if (entry.kind === "USAGE") return entry.pages ? `Read ${plural(entry.pages, "page")}` : KIND_LABEL.USAGE;
  if (entry.kind === "GRANT" && entry.milliCredits < 0) return "Correction";
  return KIND_LABEL[entry.kind];
}

export function CreditsSection({ initial }: { initial: CreditAccount }) {
  const [entries, setEntries] = useState(initial.entries);
  const [cursor, setCursor] = useState(initial.nextCursor);
  const [loadingMore, setLoadingMore] = useState(false);
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function showOlder() {
    if (!cursor) return;
    setLoadingMore(true);
    const result = await getJson<CreditAccount>(`/api/account/credits?cursor=${encodeURIComponent(cursor)}`);
    setLoadingMore(false);
    if (!result.ok) {
      toast.error(result.error.message);
      return;
    }
    setEntries((current) => [...current, ...result.data.entries]);
    setCursor(result.data.nextCursor);
  }

  async function request() {
    const parsed = creditRequestSchema.safeParse({ note });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Check the note.");
      return;
    }
    setError(null);
    setPending(true);
    const result = await postJson<{ sent: true }>("/api/account/credit-requests", parsed.data);
    setPending(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setAsking(false);
    setNote("");
    toast.success("Your request was sent. You'll see the credits here once they're added.");
  }

  const available = initial.balance - initial.reserved;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <p className="text-sm">
          <span className="text-2xl font-semibold tabular-nums">{formatCredits(Math.max(0, available), "down")}</span>{" "}
          <span className="text-muted-foreground">
            credits left
            {initial.pagesLeft !== null ? `, about ${plural(initial.pagesLeft, "page")} at what your pages have cost so far` : ""}.
          </span>
        </p>
        <p className="text-muted-foreground text-xs">
          {creditCount(initial.used)} used so far.
          {initial.reserved > 0 ? ` ${creditCount(initial.reserved)} held by readings in progress.` : ""}
          {available < 0 ? " Your last reading cost more than was left, so the balance is below zero." : ""} A reading that fails costs
          nothing.
        </p>
      </div>

      {initial.canRequest ? (
        asking ? (
          <div className="flex max-w-xl flex-col gap-2">
            <Label htmlFor="credit-note">What are they for? (optional)</Label>
            <Textarea
              id="credit-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={500}
              rows={3}
              placeholder="For example: 300 pages of a clinic register this month."
              disabled={pending}
            />
            {error ? <FormMessage tone="error">{error}</FormMessage> : null}
            <div className="flex gap-2">
              <Button type="button" onClick={() => void request()} disabled={pending}>
                {pending ? "Sending…" : "Send request"}
              </Button>
              <Button type="button" variant="outline" onClick={() => setAsking(false)} disabled={pending}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div>
            <Button type="button" variant="outline" onClick={() => setAsking(true)}>
              Request more
            </Button>
          </div>
        )
      ) : null}

      {entries.length > 0 ? (
        <div className="flex flex-col gap-2">
          <table className="w-full text-sm">
            <caption className="sr-only">Credit history, newest first</caption>
            <thead className="text-muted-foreground text-left text-xs">
              <tr>
                <th scope="col" className="py-1 font-normal">
                  Date
                </th>
                <th scope="col" className="py-1 font-normal">
                  What
                </th>
                <th scope="col" className="py-1 text-right font-normal">
                  Credits
                </th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id} className="border-t">
                  <td className="py-1.5 tabular-nums">{isoDate(entry.createdAt)}</td>
                  <td className="py-1.5">
                    {entryLabel(entry)}
                    {entry.note ? <span className="text-muted-foreground"> · {entry.note}</span> : null}
                  </td>
                  <td className="py-1.5 text-right tabular-nums">
                    {entry.milliCredits > 0 ? "+" : entry.milliCredits < 0 ? "−" : ""}
                    {formatCredits(Math.abs(entry.milliCredits))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {cursor ? (
            <div>
              <Button type="button" variant="ghost" size="sm" onClick={() => void showOlder()} disabled={loadingMore}>
                {loadingMore ? "Loading…" : "Show older"}
              </Button>
            </div>
          ) : null}
        </div>
      ) : (
        <p className="text-muted-foreground text-sm">Nothing has been read yet.</p>
      )}
    </div>
  );
}
