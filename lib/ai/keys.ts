import { decryptSecret, encryptionConfigured, SecretCryptoError } from "@/lib/crypto";
import { prisma } from "@/lib/db";
import { getEnv } from "@/lib/env";

/**
 * Which API key a run uses (Phase 12, decision 54). A user may bring their own Gemini key; the
 * deployment's `GEMINI_API_KEY` stays as the fallback for people the owner invites directly.
 *
 * Server-only, and deliberately free of any provider SDK import so request handlers can ask without
 * loading one.
 *
 * A stored key that will not decrypt resolves to `none`, never to the server key. Falling back
 * silently would put that user's extraction back on the owner's bill, which is the exposure this
 * whole arrangement exists to close.
 */

export type AiKeySource = "user" | "server" | "fake";

export type AiKey =
  | { source: "user"; key: string; hint: string }
  | { source: "server"; key: string }
  /** AI_PROVIDER=fake (local work and CI): the stub never calls the network, so no key is involved. */
  | { source: "fake" }
  | { source: "none"; message: string };

export const NO_KEY_MESSAGE =
  "AI reading isn't set up yet, so nothing can be extracted. Add your own Gemini key on your account page, or ask whoever runs SaaKuu to add one.";

export const UNREADABLE_KEY_MESSAGE = "Your saved AI key couldn't be read. Open your account page and save it again.";

export async function resolveAiKey(userId: string): Promise<AiKey> {
  const env = getEnv();
  if (env.AI_PROVIDER === "fake") return { source: "fake" };

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { aiApiKeyCipher: true, aiApiKeyHint: true } });
  if (user?.aiApiKeyCipher) {
    try {
      return { source: "user", key: decryptSecret(user.aiApiKeyCipher), hint: user.aiApiKeyHint ?? "" };
    } catch (err) {
      if (err instanceof SecretCryptoError) return { source: "none", message: UNREADABLE_KEY_MESSAGE };
      throw err;
    }
  }

  if (env.GEMINI_API_KEY) return { source: "server", key: env.GEMINI_API_KEY };
  return { source: "none", message: NO_KEY_MESSAGE };
}

/** The key string to build a provider with; `undefined` for the fake provider, which needs none. */
export function keyMaterial(resolved: AiKey): string | undefined {
  return resolved.source === "user" || resolved.source === "server" ? resolved.key : undefined;
}

/** Whether this deployment can store per-user keys at all, for the account page. */
export function canStoreUserKeys(): boolean {
  return encryptionConfigured();
}

/** Whether a user who removes their own key still has something to fall back to. */
export function serverKeyConfigured(): boolean {
  const env = getEnv();
  return env.AI_PROVIDER === "fake" || Boolean(env.GEMINI_API_KEY);
}
