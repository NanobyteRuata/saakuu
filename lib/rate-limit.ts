import { Redis } from "ioredis";

import { getEnv } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { log } from "@/lib/log";

/**
 * Fixed-window request limits kept in Redis. Keys are `saakuu:rl:{rule}:{id}` where `id` is an
 * email, client address or user id. Limits fail open: if Redis is unreachable the request goes
 * through (and is logged), so a Redis hiccup never locks people out of signing in.
 */

const MINUTE = 60_000;

export const RATE_LIMITS = {
  registerEmail: { max: 5, windowMs: 60 * MINUTE },
  registerIp: { max: 60, windowMs: 60 * MINUTE },
  emailLinkEmail: { max: 3, windowMs: 15 * MINUTE },
  emailLinkIp: { max: 30, windowMs: 60 * MINUTE },
  tokenIp: { max: 60, windowMs: 15 * MINUTE },
  // Per email *and* address, so a stranger can't lock someone out by typing wrong passwords for their email.
  signInFailEmailIp: { max: 10, windowMs: 15 * MINUTE },
  // Per email alone: a looser backstop against guessing one account's password from many addresses.
  signInFailEmail: { max: 50, windowMs: 15 * MINUTE },
  signInFailIp: { max: 100, windowMs: 15 * MINUTE },
  // Saving or removing a personal API key: a handful of attempts is normal, a hundred is not.
  accountAiKey: { max: 10, windowMs: MINUTE },
  extractionStart: { max: 20, windowMs: MINUTE },
  extractionEstimate: { max: 120, windowMs: MINUTE },
  // Phase 16: each one reads a page with the operator's money; a handful a minute is already a lot.
  fieldProposalStart: { max: 10, windowMs: MINUTE },
  // Phase 22: each one emails whoever runs SaaKuu; asking three times in a day is already insistent.
  creditRequest: { max: 3, windowMs: 24 * 60 * MINUTE },
} as const;

export type RateLimitRule = keyof typeof RATE_LIMITS;

export type RateLimitState = { limited: boolean; retryAfterSeconds: number };

const OPEN: RateLimitState = { limited: false, retryAfterSeconds: 0 };

const globalForLimits = globalThis as unknown as { saakuuRateLimitRedis?: Redis };

function redis(): Redis {
  const current = globalForLimits.saakuuRateLimitRedis;
  if (current && current.status !== "end") return current;
  // Unlike the queue producers this keeps an offline queue, so the first checks after start wait for the
  // connection instead of failing open; the command timeout still fails open quickly if Redis is down.
  const connection = new Redis(getEnv().REDIS_URL, {
    maxRetriesPerRequest: 1,
    connectTimeout: 3000,
    commandTimeout: 1500,
    retryStrategy: (times) => Math.min(times * 500, 5000),
  });
  connection.on("error", (err) => log.warn("rate limit redis error", { error: err.message }));
  globalForLimits.saakuuRateLimitRedis = connection;
  return connection;
}

const key = (rule: RateLimitRule, id: string) => `saakuu:rl:${rule}:${id.toLowerCase()}`;

/** Rules whose key is, or ends with, the client address. */
const ADDRESS_RULES: ReadonlySet<RateLimitRule> = new Set(["registerIp", "emailLinkIp", "tokenIp", "signInFailIp", "signInFailEmailIp"]);
const LOOPBACK: ReadonlySet<string> = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * Whether this check runs. Outside production, per-address rules skip loopback: every local and E2E request comes
 * from the same address and would share one allowance. Per-email and per-user rules always apply.
 */
function applies(rule: RateLimitRule, id: string): boolean {
  const env = getEnv();
  if (!env.RATE_LIMIT_ENABLED) return false;
  return !(env.NODE_ENV !== "production" && ADDRESS_RULES.has(rule) && LOOPBACK.has(id.split("|").at(-1) ?? id));
}

function stateFor(rule: RateLimitRule, count: number, ttlMs: number, counting: boolean): RateLimitState {
  const { max, windowMs } = RATE_LIMITS[rule];
  const limited = counting ? count > max : count >= max;
  const remainingMs = ttlMs > 0 ? ttlMs : windowMs;
  return { limited, retryAfterSeconds: limited ? Math.max(1, Math.ceil(remainingMs / 1000)) : 0 };
}

/** Counts one request against the rule and reports whether it is over the limit. */
export async function hitRateLimit(rule: RateLimitRule, id: string): Promise<RateLimitState> {
  if (!applies(rule, id)) return OPEN;
  try {
    const k = key(rule, id);
    const result = await redis()
      .multi()
      .incr(k)
      .pexpire(k, RATE_LIMITS[rule].windowMs, "NX")
      .pttl(k)
      .exec();
    const count = Number(result?.[0]?.[1] ?? 0);
    const ttl = Number(result?.[2]?.[1] ?? -1);
    return stateFor(rule, count, ttl, true);
  } catch (err) {
    log.warn("rate limit check skipped", { rule, error: err instanceof Error ? err.message : String(err) });
    return OPEN;
  }
}

/** Reports whether the rule is already exhausted, without counting this request. */
export async function peekRateLimit(rule: RateLimitRule, id: string): Promise<RateLimitState> {
  if (!applies(rule, id)) return OPEN;
  try {
    const k = key(rule, id);
    const result = await redis().multi().get(k).pttl(k).exec();
    const count = Number(result?.[0]?.[1] ?? 0);
    const ttl = Number(result?.[1]?.[1] ?? -1);
    return stateFor(rule, count, ttl, false);
  } catch (err) {
    log.warn("rate limit check skipped", { rule, error: err instanceof Error ? err.message : String(err) });
    return OPEN;
  }
}

function rateLimitedError(retryAfterSeconds: number): AppError {
  const minutes = Math.ceil(retryAfterSeconds / 60);
  const wait = retryAfterSeconds < 90 ? "a minute" : minutes < 120 ? `${minutes} minutes` : `${Math.ceil(minutes / 60)} hours`;
  return new AppError("RATE_LIMITED", `Too many attempts. Wait ${wait} and try again.`, { retryAfterSeconds });
}

/** Counts the request against every given rule; throws `RATE_LIMITED` if any is exceeded. */
export async function enforceRateLimits(checks: ReadonlyArray<readonly [RateLimitRule, string]>): Promise<void> {
  const states = await Promise.all(checks.map(([rule, id]) => hitRateLimit(rule, id)));
  const worst = states.filter((s) => s.limited).sort((a, b) => b.retryAfterSeconds - a.retryAfterSeconds)[0];
  if (worst) {
    log.warn("rate limited", { rules: checks.filter((_, i) => states[i]?.limited).map(([rule]) => rule) });
    throw rateLimitedError(worst.retryAfterSeconds);
  }
}
