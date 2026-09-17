import { z } from "zod";

import { log } from "@/lib/log";
import { resolveRequestId, withLogContext } from "@/lib/log-context";

/** Stable error codes. See docs/04-api-surface.md → Conventions. */
export const ERROR_CODES = [
  "UNAUTHORIZED",
  "NOT_FOUND",
  "VALIDATION",
  "CONFLICT",
  "RATE_LIMITED",
  "PROVIDER_ERROR",
  "INTERNAL",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const HTTP_STATUS: Record<ErrorCode, number> = {
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  VALIDATION: 400,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  PROVIDER_ERROR: 502,
  INTERNAL: 500,
};

/** Plain-language fallbacks shown to the user when no specific message is given. */
const DEFAULT_MESSAGE: Record<ErrorCode, string> = {
  UNAUTHORIZED: "You need to sign in to do that.",
  NOT_FOUND: "We couldn't find what you were looking for.",
  VALIDATION: "Some of the information you entered isn't valid.",
  CONFLICT: "This changed while you were working on it. Reload and try again.",
  RATE_LIMITED: "Too many requests right now. Wait a moment and try again.",
  PROVIDER_ERROR: "The AI service had a problem. You can retry.",
  INTERNAL: "Something went wrong on our side. Try again in a moment.",
};

export function httpStatusFor(code: ErrorCode): number {
  return HTTP_STATUS[code];
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details: unknown;

  constructor(code: ErrorCode, message?: string, details?: unknown) {
    super(message ?? DEFAULT_MESSAGE[code]);
    this.name = "AppError";
    this.code = code;
    this.details = details;
  }
}

export type ErrorBody = { code: ErrorCode; message: string; details?: unknown };

export type Result<T> = { ok: true; data: T } | { ok: false; error: ErrorBody };

export function ok<T>(data: T): Result<T> {
  return { ok: true, data };
}

export function fail(code: ErrorCode, message?: string, details?: unknown): Result<never> {
  return {
    ok: false,
    error: { code, message: message ?? DEFAULT_MESSAGE[code], ...(details === undefined ? {} : { details }) },
  };
}

/**
 * Converts any thrown value into a user-safe error result.
 * Unknown errors are logged with their stack and surfaced as a generic INTERNAL.
 */
export function toErrorResult(err: unknown): Result<never> {
  if (err instanceof AppError) {
    return fail(err.code, err.message, err.details);
  }
  if (err instanceof z.ZodError) {
    return fail("VALIDATION", undefined, z.flattenError(err));
  }
  log.error("unhandled error", err);
  return fail("INTERNAL");
}

/**
 * Runs a Server Action / Route Handler body and always returns a `Result`.
 * Business logic throws `AppError`; this is the single place it is caught. Log lines written
 * inside carry the request id, and jobs enqueued inside carry it as their correlation id.
 */
export async function runAction<T>(fn: () => Promise<T>): Promise<Result<T>> {
  return withLogContext({ requestId: await resolveRequestId() }, async () => {
    try {
      return ok(await fn());
    } catch (err) {
      return toErrorResult(err);
    }
  });
}

function retryAfter(details: unknown): number | null {
  if (typeof details !== "object" || details === null || !("retryAfterSeconds" in details)) return null;
  return typeof details.retryAfterSeconds === "number" ? details.retryAfterSeconds : null;
}

/** Serialises a `Result` for a Route Handler with the matching HTTP status. */
export function resultResponse<T>(result: Result<T>, successStatus = 200): Response {
  const status = result.ok ? successStatus : httpStatusFor(result.error.code);
  const wait = result.ok ? null : retryAfter(result.error.details);
  return Response.json(result, { status, headers: wait === null ? undefined : { "Retry-After": String(wait) } });
}
