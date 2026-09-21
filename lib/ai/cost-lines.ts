import { plural } from "@/lib/format";

import type { AiKeySource } from "./keys";

/** Client-safe wording shared by every dialog that spends money on the AI (extraction, template proposal). */

/**
 * Which key this spends (Phase 12, decision 54). The operator is about to pay for it, so the dialog
 * says whose account it lands on before they confirm, not after.
 */
export function keyLine(estimate: { keySource: AiKeySource | null; keyHint: string | null }): string | null {
  switch (estimate.keySource) {
    case "user":
      return `Uses your own AI key${estimate.keyHint ? ` (····${estimate.keyHint})` : ""}.`;
    case "server":
      return "Uses this server's AI key.";
    default:
      return null;
  }
}

export function aboutTime(seconds: number): string {
  if (seconds < 60) return "under a minute";
  const minutes = Math.round(seconds / 60);
  return minutes < 90 ? `about ${plural(minutes, "minute")}` : `about ${plural(Math.round(minutes / 60), "hour")}`;
}
