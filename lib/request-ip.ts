import { getEnv } from "@/lib/env";

/**
 * The client's address for rate limiting.
 *
 * `X-Forwarded-For` is a list each proxy appends to, so its leftmost entries are whatever the client sent and can't be
 * trusted. With `TRUSTED_PROXY_HOPS` proxies in front of the app (default 1), the client is that many entries from the
 * right: the address the outermost trusted proxy saw. With no proxy, Next.js sets the header to the socket address
 * when the request has none (one entry, so 1 hop is still right); a client talking to the app directly can forge it,
 * which is why production must run behind a proxy (docs/09 §6).
 */
export function clientIp(headers: Headers): string {
  const entries = (headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
  if (entries.length > 0) {
    const hops = getEnv().TRUSTED_PROXY_HOPS;
    // Fewer entries than trusted hops means a hop didn't append; the leftmost is the best remaining guess.
    return entries[Math.max(entries.length - hops, 0)] ?? "unknown";
  }
  return headers.get("x-real-ip")?.trim() || "unknown";
}
