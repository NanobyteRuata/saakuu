import { ProviderError } from "./provider";

const RETRIES = 3;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 20_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retries a model call up to 3 times on rate limits and outages, with exponential backoff and full
 * jitter (docs/03 §7 step 5). Other failures are thrown at once. Rate limits start from a longer delay.
 */
export async function withProviderRetry<T>(call: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (err) {
      if (!(err instanceof ProviderError) || !err.transient || attempt >= RETRIES) throw err;
      const base = err.kind === "RATE_LIMITED" ? BASE_DELAY_MS * 4 : BASE_DELAY_MS;
      await sleep(Math.random() * Math.min(MAX_DELAY_MS, base * 2 ** attempt));
    }
  }
}
