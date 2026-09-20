import { resolveAiKey, type AiKeySource } from "./keys";

/** Kept apart from `lib/ai/index.ts` so request handlers can ask without loading a provider SDK. */
export type ProviderStatus =
  /** `hint` is the last four characters of the user's own key, for the dialog to name which key runs. */
  | { ready: true; keySource: AiKeySource; hint: string | null }
  | { ready: false; message: string };

/**
 * Whether extraction can work for this user, so the UI can say so before anything is queued. Per-user
 * since Phase 12: a user with their own key can extract on a server that has none of its own.
 */
export async function providerStatus(userId: string): Promise<ProviderStatus> {
  const resolved = await resolveAiKey(userId);
  if (resolved.source === "none") return { ready: false, message: resolved.message };
  return { ready: true, keySource: resolved.source, hint: resolved.source === "user" ? resolved.hint : null };
}
