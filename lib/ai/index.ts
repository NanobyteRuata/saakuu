import { getEnv } from "@/lib/env";

import { createFakeProvider } from "./fake";
import { createGeminiProvider } from "./gemini";
import type { AIProvider } from "./provider";

/** Server-only. The worker is the only caller of `extract`; request handlers never run extraction. */

/**
 * One provider per key (Phase 12: each user may bring their own). Building one is cheap — the Gemini
 * client is created lazily on first call — but caching keeps the SDK's connection reuse. Bounded so a
 * long-lived worker can't accumulate providers for keys nobody uses any more.
 */
const MAX_CACHED = 50;
const cache = new Map<string, AIProvider>();

export function getProvider(apiKey: string | undefined): AIProvider {
  const env = getEnv();
  const cacheKey = env.AI_PROVIDER === "fake" ? `fake:${env.AI_FAKE_BEHAVIOUR}` : `gemini:${env.AI_THINKING}:${apiKey ?? ""}`;
  const existing = cache.get(cacheKey);
  if (existing) return existing;
  const provider = env.AI_PROVIDER === "fake" ? createFakeProvider(env.AI_FAKE_BEHAVIOUR) : createGeminiProvider(apiKey, env.AI_THINKING);
  // Drop the oldest rather than clearing: a Map iterates in insertion order, and clearing would evict
  // the server key every run of nearly every book uses to make room for one stranger's.
  if (cache.size >= MAX_CACHED) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(cacheKey, provider);
  return provider;
}
