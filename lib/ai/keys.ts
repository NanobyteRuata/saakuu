import { inviteOnly, isInvited } from "@/lib/auth/allowlist";
import { decryptSecret, encryptionConfigured, SecretCryptoError } from "@/lib/crypto";
import { prisma } from "@/lib/db";
import { getEnv } from "@/lib/env";

import { SERVER_SIDE_PROBLEM } from "./provider";

/**
 * Which API key a run uses (Phase 12, decision 54; Phase 21, decision 79). Everyone reads on the
 * deployment's `GEMINI_API_KEY`. Bringing your own Gemini key is still here but dormant: it only
 * exists on a deployment that sets `ENCRYPTION_KEY`, and there a saved key wins over the server's.
 *
 * Server-only, and deliberately free of any provider SDK import so request handlers can ask without
 * loading one.
 *
 * Where personal keys are on, a stored key that will not decrypt resolves to `none`, never to the
 * server key. Falling back silently would put that user's extraction back on the owner's bill.
 * Where they are off, a key saved back when they were on is not read at all: it cannot be
 * decrypted, and treating it as broken would lock that user out of a server that reads for everyone.
 */

export type AiKeySource = "user" | "server" | "fake";

export type AiKey =
  | { source: "user"; key: string; hint: string }
  | { source: "server"; key: string }
  /** AI_PROVIDER=fake (local work and CI): the stub never calls the network, so no key is involved. */
  | { source: "fake" }
  | { source: "none"; message: string };

/** Said only where a personal key is something the user could actually go and add. */
const NO_KEY_ADD_YOUR_OWN =
  "AI reading isn't set up yet, so nothing can be extracted. Add your own Gemini key on your account page, or ask whoever runs SaaKuu to add one.";

/** On the invite list's far side: the account exists, and the server's key is not for it. */
export const NOT_INVITED_MESSAGE = "Reading pages isn't switched on for this account. Ask whoever invited you to SaaKuu to switch it on.";

export const UNREADABLE_KEY_MESSAGE = "Your saved AI key couldn't be read. Open your account page and save it again.";

export async function resolveAiKey(userId: string): Promise<AiKey> {
  const env = getEnv();
  if (env.AI_PROVIDER === "fake") return { source: "fake" };

  const byo = canStoreUserKeys();
  const listed = inviteOnly();
  const user =
    byo || listed
      ? await prisma.user.findUnique({ where: { id: userId }, select: { email: true, aiApiKeyCipher: true, aiApiKeyHint: true } })
      : null;
  if (byo && user?.aiApiKeyCipher) {
    try {
      return { source: "user", key: decryptSecret(user.aiApiKeyCipher), hint: user.aiApiKeyHint ?? "" };
    } catch (err) {
      if (err instanceof SecretCryptoError) return { source: "none", message: UNREADABLE_KEY_MESSAGE };
      throw err;
    }
  }

  if (!env.GEMINI_API_KEY) return { source: "none", message: byo ? NO_KEY_ADD_YOUR_OWN : SERVER_SIDE_PROBLEM };
  // The list is the spend limit, so it is asked here too and not only at sign-up: taking someone off
  // it has to stop the spending, and an account made before there was a list was never invited.
  if (listed && !(user && isInvited(user.email))) return { source: "none", message: NOT_INVITED_MESSAGE };
  return { source: "server", key: env.GEMINI_API_KEY };
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
