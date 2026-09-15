import { z } from "zod";

/**
 * Models a book or template can choose. Provider-neutral descriptors only: the Gemini
 * implementation (Phase 5) maps these ids to its own client. Client-safe.
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
  },
  {
    id: "gemini-3.7-flash",
    label: "Gemini 3.7 Flash",
    description: "Newer Flash model. Try it on handwriting 3.5 Flash struggles with.",
    costTier: "low",
    secondsPerPage: 10,
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
