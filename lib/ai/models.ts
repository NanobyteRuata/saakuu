import { z } from "zod";

/**
 * Models a book or template can choose. Provider-neutral descriptors only: the Gemini
 * implementation (Phase 5) maps these ids to its own client. Client-safe.
 */
export const AI_MODELS = [
  {
    id: "gemini-2.5-flash",
    label: "Gemini 2.5 Flash",
    description: "Fast and low cost. A good default for most forms.",
    costTier: "low",
  },
  {
    id: "gemini-2.5-pro",
    label: "Gemini 2.5 Pro",
    description: "Slower and more expensive. Try it on handwriting Flash struggles with.",
    costTier: "high",
  },
] as const;

export type AIModelId = (typeof AI_MODELS)[number]["id"];

export const DEFAULT_MODEL_ID: AIModelId = "gemini-2.5-flash";

export const modelIdSchema = z.enum(["gemini-2.5-flash", "gemini-2.5-pro"], {
  error: "Choose one of the available models.",
});

export function modelLabel(id: string): string {
  return AI_MODELS.find((m) => m.id === id)?.label ?? id;
}
