import type { Result } from "@/lib/errors";

/**
 * Client-side JSON calls to Route Handlers that return a `Result`. Network failures and
 * non-JSON responses become a plain-language INTERNAL error, never an exception.
 */
async function requestJson<T>(method: string, url: string, body?: unknown): Promise<Result<T>> {
  try {
    const res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return (await res.json()) as Result<T>;
  } catch {
    return {
      ok: false,
      error: { code: "INTERNAL", message: "We couldn't reach the server. Check your connection and try again." },
    };
  }
}

export function getJson<T>(url: string): Promise<Result<T>> {
  return requestJson<T>("GET", url);
}

export function postJson<T>(url: string, body: unknown): Promise<Result<T>> {
  return requestJson<T>("POST", url, body);
}

export function patchJson<T>(url: string, body: unknown): Promise<Result<T>> {
  return requestJson<T>("PATCH", url, body);
}

export function deleteJson<T>(url: string): Promise<Result<T>> {
  return requestJson<T>("DELETE", url);
}
