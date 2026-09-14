import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { AppError, fail, httpStatusFor, ok, resultResponse, runAction, toErrorResult } from "./errors";

describe("errors", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("wraps success", () => {
    expect(ok({ a: 1 })).toEqual({ ok: true, data: { a: 1 } });
  });

  it("uses a plain-language default message", () => {
    const result = fail("NOT_FOUND");
    expect(result).toEqual({
      ok: false,
      error: { code: "NOT_FOUND", message: "We couldn't find what you were looking for." },
    });
  });

  it("maps AppError to its code and message", () => {
    const result = toErrorResult(new AppError("CONFLICT", "Stale impact report.", { hash: "x" }));
    expect(result).toEqual({
      ok: false,
      error: { code: "CONFLICT", message: "Stale impact report.", details: { hash: "x" } },
    });
  });

  it("maps ZodError to VALIDATION", () => {
    const parsed = z.object({ name: z.string() }).safeParse({});
    if (parsed.success) throw new Error("expected failure");
    const result = toErrorResult(parsed.error);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  it("hides unknown errors behind INTERNAL and logs the stack", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await runAction(async () => {
      throw new Error("db password is hunter2");
    });
    expect(result).toEqual({
      ok: false,
      error: { code: "INTERNAL", message: "Something went wrong on our side. Try again in a moment." },
    });
    expect(spy).toHaveBeenCalledOnce();
    expect(String(spy.mock.calls[0]?.[0])).toContain("hunter2");
  });

  it("maps codes to HTTP statuses", async () => {
    expect(httpStatusFor("UNAUTHORIZED")).toBe(401);
    expect(httpStatusFor("RATE_LIMITED")).toBe(429);
    const res = resultResponse(fail("VALIDATION"));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
  });
});
