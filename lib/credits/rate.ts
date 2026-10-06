import { modelPrice } from "@/lib/ai/models";

/**
 * What a credit is (Phase 22, decision 81). Client-safe and pure.
 *
 * A credit is a fixed slice of what a reading costs the deployment at the model's list price, so one
 * balance covers extraction, template proposals and anything added later, on any model, and a full
 * table page can never cost more than it charges. `CREDIT_MICRO_USD` is that slice: $0.02, about one
 * typical form page on Gemini 3.5 Flash (some 3,000 tokens in and 1,500 out, thinking included). It carries no markup — what a credit sells for is decided when
 * credits are sold, and changing this constant changes what future readings charge, never the ledger.
 *
 * Everything is an integer: cost in millionths of a dollar, credits in thousandths of a credit.
 */

export const CREDIT_MICRO_USD = 20_000;

const MILLI = 1000;

type Usage = { model: string; inputTokens: number; outputTokens: number; at?: Date };

/**
 * Millionths of a dollar for a reading's tokens, rounded up, at the model's price on `at` (now, unless
 * given). A model with no price costs nothing it can prove.
 */
export function costMicroUsd({ model, inputTokens, outputTokens, at }: Usage): number {
  const price = modelPrice(model, at);
  if (!price) return 0;
  // Dollars per million tokens is micro-dollars per token. Prices are held in thousandths to stay
  // whole, so a price is exact to a tenth of a cent per million tokens and no finer.
  const thousandths = Math.max(0, inputTokens) * Math.round(price.inputPricePerMTok * MILLI) + Math.max(0, outputTokens) * Math.round(price.outputPricePerMTok * MILLI);
  return Math.ceil(thousandths / MILLI);
}

/** Rounded up, so a reading that cost anything charges at least a thousandth of a credit. */
export function toMilliCredits(microUsd: number): number {
  return Math.ceil((Math.max(0, microUsd) * MILLI) / CREDIT_MICRO_USD);
}

export function milliCreditsFor(usage: Usage): number {
  return toMilliCredits(costMicroUsd(usage));
}

type Rounding = "nearest" | "up" | "down";

/**
 * `12.3`. One decimal: finer than that reads as noise, coarser hides what a single page cost.
 * What something needs is rounded `up` and what someone has is rounded `down`, so a reading is never
 * refused with the two numbers reading the same.
 */
export function formatCredits(milliCredits: number, rounding: Rounding = "nearest"): string {
  const tenths = milliCredits / 100;
  const whole = rounding === "up" ? Math.ceil(tenths) : rounding === "down" ? Math.floor(tenths) : Math.round(tenths);
  return (whole / 10).toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

/** `12.3 credits`, `1.0 credit`. */
export function creditCount(milliCredits: number, rounding: Rounding = "nearest"): string {
  const text = formatCredits(milliCredits, rounding);
  return `${text} ${text === "1.0" ? "credit" : "credits"}`;
}

export type StartDecision = { ok: true } | { ok: false; reason: "short" | "daily"; message: string };

export const DAILY_CAP_MESSAGE = "SaaKuu has read as much as it can today. Try again tomorrow; your credits are untouched.";

export function shortMessage(estimate: number, available: number): string {
  return `This needs about ${creditCount(estimate, "up")}. You have ${formatCredits(Math.max(0, available), "down")}.`;
}

/**
 * Whether a reading may start. `available` is null where credits aren't enforced, and `dailyCap` is
 * null where there is no ceiling; both are in thousandths of a credit, like `estimate`.
 *
 * The estimate has to fit, not the eventual charge: a reading is charged what it really cost, so a
 * balance can end a little below zero, and then the next one is refused here.
 */
export function decideStart(input: { estimate: number; available: number | null; dailyUsed: number; dailyCap: number | null }): StartDecision {
  if (input.available !== null && input.estimate > input.available) {
    return { ok: false, reason: "short", message: shortMessage(input.estimate, input.available) };
  }
  if (input.dailyCap !== null && input.dailyUsed + input.estimate > input.dailyCap) {
    return { ok: false, reason: "daily", message: DAILY_CAP_MESSAGE };
  }
  return { ok: true };
}

/** What the dialogs show about credits; null where they aren't in play (not enforced, or a personal key). */
export type CreditEstimate = {
  /** Thousandths of a credit. */
  estimate: number;
  available: number;
  /** Why this can't start, in plain language; null when it can. */
  problem: string | null;
};

/** Splits a document's estimate over its runs by page count, so each run holds its own share. */
export function shareByPages(total: number, pageCounts: number[]): number[] {
  const pages = pageCounts.reduce((sum, n) => sum + n, 0);
  if (pages === 0) return pageCounts.map(() => 0);
  return pageCounts.map((n) => Math.ceil((total * n) / pages));
}
