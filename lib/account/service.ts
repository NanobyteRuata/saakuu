import { canStoreUserKeys, serverKeyConfigured } from "@/lib/ai/keys";
import { AI_MODELS, estimateCostUsd, type AIModelId } from "@/lib/ai/models";
import { requireUserId } from "@/lib/auth/guards";
import { encryptSecret, secretHint, SecretCryptoError } from "@/lib/crypto";
import { prisma } from "@/lib/db/client";
import { AppError } from "@/lib/errors";

/**
 * The account area (Phase 12): a user's own Gemini key, and what extraction has cost them so far.
 *
 * The key itself never leaves this module. Callers get `hint` — its last four characters — which is
 * all the UI ever shows (decision 54).
 */

export type AiAccount = {
  /** Last four characters of the key this user reads with, or null when they read on the server's. */
  hint: string | null;
  /** Whether this deployment can store a user key at all (ENCRYPTION_KEY is set). */
  canStoreKey: boolean;
  /** Whether removing a personal key still leaves something to extract with. */
  serverKey: boolean;
  spend: AiSpend;
};

/** Money already spent, from the token columns recorded since Phase 5. No new data was needed. */
export type AiSpend = {
  costUsd: number;
  /** Completed runs that `costUsd` actually covers. */
  runs: number;
  /** Completed runs on a model that no longer has a price, so they contributed nothing to `costUsd`. */
  unpricedRuns: number;
  documents: number;
};

export async function aiAccount(userId: string): Promise<AiAccount> {
  const uid = requireUserId(userId);
  const canStoreKey = canStoreUserKeys();
  const [user, spend] = await Promise.all([
    canStoreKey ? prisma.user.findUnique({ where: { id: uid }, select: { aiApiKeyHint: true, aiApiKeyCipher: true } }) : null,
    aiSpend(uid),
  ]);
  return {
    // A key saved while personal keys were on is not in use once they are off (`resolveAiKey`).
    hint: user?.aiApiKeyCipher ? (user.aiApiKeyHint ?? "") : null,
    canStoreKey,
    serverKey: serverKeyConfigured(),
    spend,
  };
}

/**
 * Totals every completed run of every book this user owns, priced per model — a run of a cheap model
 * and a run of an expensive one are not comparable in tokens, which is why the sum is grouped first.
 *
 * **Deleted books and documents are counted on purpose**, which is why nothing here filters
 * `deletedAt` the way the rest of the codebase does. This is a record of money that was spent, and
 * deleting the paperwork afterwards does not refund it. Excluding them would make the figure fall
 * when a user tidies up, which is the one thing a spend readout must never do.
 *
 * `runs` and `unpricedRuns` are kept apart so the page never claims a total covers more readings than
 * it priced.
 */
export async function aiSpend(userId: string): Promise<AiSpend> {
  const uid = requireUserId(userId);
  const rows = await prisma.extractionRun.groupBy({
    by: ["model"],
    where: { state: "COMPLETE", document: { book: { userId: uid } } },
    _sum: { inputTokens: true, outputTokens: true },
    _count: { _all: true },
  });
  const known = new Set<string>(AI_MODELS.map((m) => m.id));
  let costUsd = 0;
  let runs = 0;
  let unpricedRuns = 0;
  for (const row of rows) {
    // A run of a model that has since been removed still counted tokens; it just can't be priced.
    if (!known.has(row.model)) {
      unpricedRuns += row._count._all;
      continue;
    }
    runs += row._count._all;
    costUsd += estimateCostUsd({
      model: row.model as AIModelId,
      inputTokens: row._sum.inputTokens ?? 0,
      outputTokens: row._sum.outputTokens ?? 0,
    });
  }
  const documents = await prisma.document.count({ where: { book: { userId: uid }, runs: { some: { state: "COMPLETE" } } } });
  return { costUsd, runs, unpricedRuns, documents };
}

export async function saveAiKey(userId: string, key: string): Promise<{ hint: string }> {
  const uid = requireUserId(userId);
  if (!canStoreUserKeys()) {
    throw new AppError("VALIDATION", "This server can't store personal API keys yet. Ask whoever runs SaaKuu to set one up.");
  }
  let cipher: string;
  try {
    cipher = encryptSecret(key);
  } catch (err) {
    if (err instanceof SecretCryptoError) throw new AppError("VALIDATION", "This server can't store personal API keys yet.");
    throw err;
  }
  const hint = secretHint(key);
  await prisma.user.update({ where: { id: uid }, data: { aiApiKeyCipher: cipher, aiApiKeyHint: hint } });
  return { hint };
}

export async function removeAiKey(userId: string): Promise<{ hint: null }> {
  const uid = requireUserId(userId);
  await prisma.user.update({ where: { id: uid }, data: { aiApiKeyCipher: null, aiApiKeyHint: null } });
  return { hint: null };
}
