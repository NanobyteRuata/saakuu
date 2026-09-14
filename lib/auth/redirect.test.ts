import { describe, expect, it } from "vitest";

import { DEFAULT_SIGNED_IN_PATH, safeCallbackUrl } from "./redirect";

describe("safeCallbackUrl", () => {
  it("keeps same-origin relative paths", () => {
    expect(safeCallbackUrl("/books")).toBe("/books");
    expect(safeCallbackUrl("/books/abc-123?tab=table#x")).toBe("/books/abc-123?tab=table#x");
  });

  it("falls back for missing, absolute and protocol-relative URLs", () => {
    for (const bad of [null, undefined, "", "books", "https://evil.test/", "//evil.test", "/\\evil.test", "/\tevil", "javascript:alert(1)"]) {
      expect(safeCallbackUrl(bad)).toBe(DEFAULT_SIGNED_IN_PATH);
    }
  });

  it("never returns an auth page", () => {
    expect(safeCallbackUrl("/sign-in")).toBe(DEFAULT_SIGNED_IN_PATH);
    expect(safeCallbackUrl("/reset?token=abc")).toBe(DEFAULT_SIGNED_IN_PATH);
  });
});
