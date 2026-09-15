import { getEnv } from "@/lib/env";

import { createFakeProvider } from "./fake";
import { createGeminiProvider } from "./gemini";
import type { AIProvider } from "./provider";

/** Server-only. The worker is the only caller of `extract`; request handlers never run extraction. */

let cached: AIProvider | undefined;

export function getProvider(): AIProvider {
  if (cached) return cached;
  const env = getEnv();
  cached = env.AI_PROVIDER === "fake" ? createFakeProvider(env.AI_FAKE_BEHAVIOUR) : createGeminiProvider(env.GEMINI_API_KEY);
  return cached;
}
