import { getEnv } from "@/lib/env";

/** Kept apart from `lib/ai/index.ts` so request handlers can ask without loading a provider SDK. */
export type ProviderStatus = { ready: true } | { ready: false; message: string };

/** Whether extraction can work on this server at all, so the UI can say so before anything is queued. */
export function providerStatus(): ProviderStatus {
  const env = getEnv();
  if (env.AI_PROVIDER === "gemini" && !env.GEMINI_API_KEY) {
    return {
      ready: false,
      message: "AI reading isn't set up on this server yet, so nothing can be extracted. Ask whoever runs SaaKuu to add a Gemini API key.",
    };
  }
  return { ready: true };
}
