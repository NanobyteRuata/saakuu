import type { TableCell } from "./types";

/**
 * Cell state → visual channels (docs/08 §7). The only place cell styling is decided: the output table,
 * row review and column sweep all call this and render the channels it returns.
 */

export type CellVisual = {
  authorship: "extracted" | "human" | "inherited" | "awaiting";
  semantics: "ok" | "empty" | "dash" | "na" | "illegible";
  lowConfidence: boolean;
  attention: "none" | "warning" | "disagreement" | "error";
  reviewed: boolean;
};

export type CellVisualInput = Pick<
  TableCell,
  "value" | "state" | "isEdited" | "isReviewed" | "inherited" | "confidence" | "disagreement" | "validationState"
> & {
  /** Filled from a Manual field: a person typed it once for the document. */
  isManual: boolean;
  /** Filled from a Skip field: nobody reads it, it waits for a person. */
  isSkipSourced: boolean;
};

/**
 * Below this, an extracted value nobody has touched gets a dotted underline (docs/08 §3). A constant
 * since Phase 14: it was a per-book setting, but it asked an operator for a percentage over the
 * model's own self-reported confidence, which is an uncalibrated signal with no feedback loop
 * (decision 77).
 */
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.75;

export function resolveCellVisual(cell: CellVisualInput): CellVisual {
  // A — authorship, by precedence
  const authorship: CellVisual["authorship"] =
    cell.isEdited || cell.isManual ? "human" : cell.inherited ? "inherited" : cell.isSkipSourced && !cell.value ? "awaiting" : "extracted";

  // B — semantics
  const semantics: CellVisual["semantics"] =
    cell.state === "ILLEGIBLE" ? "illegible" : cell.state === "DASH" ? "dash" : cell.state === "NOT_APPLICABLE" ? "na" : !cell.value ? "empty" : "ok";

  // B — low confidence, suppressed once a human is involved
  const lowConfidence = cell.confidence != null && cell.confidence < DEFAULT_CONFIDENCE_THRESHOLD && !cell.isEdited && !cell.isReviewed;

  // C — attention, by precedence
  const attention: CellVisual["attention"] =
    cell.validationState === "ERROR" ? "error" : cell.disagreement ? "disagreement" : cell.validationState === "WARNING" ? "warning" : "none";

  return { authorship, semantics, lowConfidence, attention, reviewed: cell.isReviewed };
}
