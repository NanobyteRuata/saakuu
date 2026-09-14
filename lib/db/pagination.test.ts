import { describe, expect, it } from "vitest";

import { pageArgs, toPage } from "./pagination";

describe("cursor pagination", () => {
  it("fetches one extra row", () => {
    expect(pageArgs({ limit: 10 })).toEqual({ take: 11 });
    expect(pageArgs({ limit: 10, cursor: "abc" })).toEqual({ take: 11, skip: 1, cursor: { id: "abc" } });
  });

  it("returns a next cursor only when more rows exist", () => {
    const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(toPage(rows, 3)).toEqual({ items: rows, nextCursor: null });
    expect(toPage(rows, 2)).toEqual({ items: [{ id: "a" }, { id: "b" }], nextCursor: "b" });
  });
});
