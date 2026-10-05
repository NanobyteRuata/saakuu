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

export function aboutTime(seconds: number): string {
  if (seconds < 60) return "under a minute";
  const minutes = Math.round(seconds / 60);
  return minutes < 90 ? `about ${plural(minutes, "minute")}` : `about ${plural(Math.round(minutes / 60), "hour")}`;
}
