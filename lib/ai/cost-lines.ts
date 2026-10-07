import { creditCount, formatCredits, type CreditEstimate } from "@/lib/credits/rate";
import { plural } from "@/lib/format";

import type { AiKeySource } from "./keys";
import { formatMoney } from "./models";

/** Client-safe wording shared by every dialog that spends money on the AI (extraction, template proposal). */

/**
 * Whether money is shown at all (Phase 21, decision 79). Only when the run lands on the operator's
 * own bill. On the server's key the figure is the deployment's cost, not a price anyone is charged,
 * so it is left out and the dialog states pages and time.
 */
export function showsMoney(keySource: AiKeySource | null): boolean {
  return keySource === "user";
}

/**
 * Which key this spends (Phase 12, decision 54). Named only for a personal key: with the server's
 * there is one key and nothing to tell apart.
 */
export function keyLine(estimate: { keySource: AiKeySource | null; keyHint: string | null }): string | null {
  return estimate.keySource === "user" ? `Uses your own AI key${estimate.keyHint ? ` (····${estimate.keyHint})` : ""}.` : null;
}

/** `About $0.12, about 4 minutes.` on a personal key; `About 4 minutes.` otherwise. */
export function costLine(estimate: { keySource: AiKeySource | null; estCostUsd: number; estSeconds: number }): string {
  const time = aboutTime(estimate.estSeconds);
  if (showsMoney(estimate.keySource)) return `About ${formatMoney(estimate.estCostUsd)}, ${time}.`;
  return `${time.charAt(0).toUpperCase()}${time.slice(1)}.`;
}

/**
 * `About 4.0 credits. You have 21.3.` (Phase 22). Credits, never money: on the deployment's key the
 * figure behind them is its cost, not a price (decision 79). Null where credits aren't in play, and
 * where the reading can't start — the dialog shows `credits.problem` instead, which has both numbers.
 */
export function creditLine(estimate: { credits: CreditEstimate | null }): string | null {
  const c = estimate.credits;
  if (c === null || c.problem !== null) return null;
  return `About ${creditCount(c.estimate, "up")}. You have ${formatCredits(c.available, "down")}.`;
}

export function aboutTime(seconds: number): string {
  if (seconds < 60) return "under a minute";
  const minutes = Math.round(seconds / 60);
  return minutes < 90 ? `about ${plural(minutes, "minute")}` : `about ${plural(Math.round(minutes / 60), "hour")}`;
}

/**
 * Said before every reading (Phase 23). A blurry page is read worse and, because the model thinks
 * longer over what it can't make out, costs more: the same register cost $0.05 from a sharp scan and
 * up to $0.58 from a blurry photo. Always shown rather than detected — edge sharpness scored that
 * blurry photo as sharp as the scan, and a size limit accused good small forms.
 */
export function photoQualityLine(withCredits: boolean): string {
  return `Sharp, close photos read best. Blurry photos are read less accurately${withCredits ? " and can use more credits" : ""}.`;
}
