import { createId } from "@paralleldrive/cuid2";
import { describe, expect, it } from "vitest";

import { AppError } from "@/lib/errors";

import { confirmSchema, idSchema, paginationSchema, parseInput, searchParamsToObject } from "./index";

describe("validation conventions", () => {
  it("accepts cuid2 ids and rejects others", () => {
    expect(idSchema.safeParse(createId()).success).toBe(true);
    expect(idSchema.safeParse("not an id!").success).toBe(false);
  });

  it("parses pagination from query strings with defaults and bounds", () => {
    const params = new URLSearchParams("limit=25");
    expect(parseInput(paginationSchema, searchParamsToObject(params))).toEqual({ limit: 25 });
    expect(parseInput(paginationSchema, {})).toEqual({ limit: 50 });
    expect(() => parseInput(paginationSchema, { limit: "5000" })).toThrow(AppError);
  });

  it("requires literal confirm: true", () => {
    expect(confirmSchema.safeParse(true).success).toBe(true);
    expect(confirmSchema.safeParse("true").success).toBe(false);
  });

  it("throws VALIDATION with field errors", () => {
    try {
      parseInput(paginationSchema, { cursor: "!!" });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe("VALIDATION");
      expect((err as AppError).details).toMatchObject({ fieldErrors: { cursor: expect.any(Array) } });
    }
  });
});
