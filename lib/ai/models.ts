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
    description: "Fast and low cost. A good default for most forms.",
    costTier: "low",
    /** Rough wall time per page, for the extract estimate only. */
    secondsPerPage: 10,
    /** USD per million tokens, list price, checked 2026-09-19. */
    inputPricePerMTok: 0.3,
    outputPricePerMTok: 2.5,
  },
  {
    id: "gemini-3.7-flash",
    label: "Gemini 3.7 Flash",
    description: "Newer Flash model. Try it on handwriting 3.5 Flash struggles with.",
    costTier: "low",
    secondsPerPage: 10,
    /** USD per million tokens, list price, checked 2026-09-19. */
    inputPricePerMTok: 0.3,
    outputPricePerMTok: 2.5,
  },
] as const;

export type AIModelId = (typeof AI_MODELS)[number]["id"];

export const DEFAULT_MODEL_ID: AIModelId = "gemini-3.5-flash";

export const modelIdSchema = z.enum(["gemini-3.5-flash", "gemini-3.7-flash"], {
  error: "Choose one of the available models.",
});

export function modelLabel(id: string): string {
  return AI_MODELS.find((m) => m.id === id)?.label ?? id;
}

const PER_MILLION = 1_000_000;

/** USD for a number of tokens at one model's list price. An unknown model costs nothing it can prove. */
export function estimateCostUsd({ model, inputTokens, outputTokens }: { model: AIModelId; inputTokens: number; outputTokens: number }): number {
  const info = AI_MODELS.find((m) => m.id === model);
  if (!info) return 0;
  return (inputTokens * info.inputPricePerMTok + outputTokens * info.outputPricePerMTok) / PER_MILLION;
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
