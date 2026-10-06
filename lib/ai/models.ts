import { z } from "zod";

/**
 * Models a book or template can choose. Provider-neutral descriptors only: the Gemini
 * implementation (Phase 5) maps these ids to its own client. Client-safe.
 *
 * Prices are USD per million tokens, list price, and exist so the Extract dialog can state a cost in
 * money rather than tokens (Phase 12) — tokens mean nothing to an operator. They are an estimate:
 * the charge that actually lands depends on the pages. Re-check them against the provider's price
 * sheet when the bill stops matching the readout (docs/09 §8).
 */
export const AI_MODELS = [
  // Gemini 2.5 models are closed to new API keys. Pro (gemini-3.1-pro-preview) needs a paid plan; add it here when one is used.
  {
    id: "gemini-3.5-flash",
    label: "Gemini 3.5 Flash",
    description: "Most reliable so far.",
    /** Said only where the operator has credits to spend (Phase 22): what choosing this model does to them. */
    creditNote: "Uses more credits.",
    costTier: "low",
    /** Rough wall time per page, for the extract estimate only. */
    secondsPerPage: 10,
    /**
     * USD per million tokens, standard paid tier, checked 2026-10-06 against a real bill: one reading
     * of 1,766 tokens in and 2,870 out was charged $0.0285. Output includes thinking tokens.
     */
    inputPricePerMTok: 1.5,
    outputPricePerMTok: 9,
    priceChanges: [],
  },
  {
    id: "gemini-3.7-flash",
    label: "Gemini 3.7 Flash",
    description: "Newer. If it finds nothing on a page, try 3.5 Flash.",
    creditNote: "Uses fewer credits.",
    costTier: "low",
    secondsPerPage: 10,
    /**
     * USD per million tokens, standard paid tier, checked 2026-10-06 against a real bill. An
     * introductory price: the provider's sheet has it doubling on 2027-01-01, which `priceChanges`
     * applies on the day so nothing is undercharged for want of a commit. Re-check it then.
     */
    inputPricePerMTok: 0.75,
    outputPricePerMTok: 3.75,
    priceChanges: [{ from: "2027-01-01T00:00:00Z", inputPricePerMTok: 1.5, outputPricePerMTok: 7.5 }],
  },
] as const;

export type AIModelId = (typeof AI_MODELS)[number]["id"];

export const DEFAULT_MODEL_ID: AIModelId = "gemini-3.5-flash";

export const modelIdSchema = z.enum(["gemini-3.5-flash", "gemini-3.7-flash"], {
  error: "Choose one of the available models.",
});

/**
 * One line under a model picker: what to expect of the model, and what it does to the operator's
 * credits where they have any. Credits, never money (decision 79).
 */
export function modelHint(id: string, withCredits: boolean): string | null {
  const info = AI_MODELS.find((m) => m.id === id);
  if (!info) return null;
  return withCredits ? `${info.description} ${info.creditNote}` : info.description;
}

export function modelLabel(id: string): string {
  return AI_MODELS.find((m) => m.id === id)?.label ?? id;
}

const PER_MILLION = 1_000_000;

export type ModelPrice = { inputPricePerMTok: number; outputPricePerMTok: number };
type PriceChange = ModelPrice & { from: string };

/**
 * A model's price at a moment: its base price, or the latest announced change that has taken effect.
 * Null for a model this version doesn't know, which costs nothing it can prove.
 */
export function modelPrice(model: string, at: Date = new Date()): ModelPrice | null {
  const info = AI_MODELS.find((m) => m.id === model);
  if (!info) return null;
  let price: ModelPrice = { inputPricePerMTok: info.inputPricePerMTok, outputPricePerMTok: info.outputPricePerMTok };
  const changes: readonly PriceChange[] = info.priceChanges;
  for (const change of [...changes].sort((a, b) => a.from.localeCompare(b.from))) {
    if (at.getTime() >= Date.parse(change.from)) price = change;
  }
  return price;
}

/** USD for a number of tokens at one model's list price. An unknown model costs nothing it can prove. */
export function estimateCostUsd({ model, inputTokens, outputTokens }: { model: AIModelId; inputTokens: number; outputTokens: number }): number {
  const price = modelPrice(model);
  if (!price) return 0;
  return (inputTokens * price.inputPricePerMTok + outputTokens * price.outputPricePerMTok) / PER_MILLION;
}

/**
 * Money as an operator reads it. Below a cent it says so rather than rounding to `$0.00`, which reads
 * as free; above it, two decimals, because that is what appears on a card statement.
 */
export function formatMoney(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return "$0.00";
  if (usd < 0.01) return "less than $0.01";
  return `$${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
