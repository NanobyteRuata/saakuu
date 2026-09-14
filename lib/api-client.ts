import type { Result } from "@/lib/errors";

/**
 * Client-side JSON POST to a Route Handler that returns a `Result`. Network failures and
 * non-JSON responses become a plain-language INTERNAL error, never an exception.
 */
export async function postJson<T>(url: string, body: unknown): Promise<Result<T>> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await res.json()) as Result<T>;
  } catch {
    return {
      ok: false,
      error: { code: "INTERNAL", message: "We couldn't reach the server. Check your connection and try again." },
    };
  }
}
