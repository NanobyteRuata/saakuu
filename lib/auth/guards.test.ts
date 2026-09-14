import { beforeEach, describe, expect, it, vi } from "vitest";

const findFirst = vi.fn();

vi.mock("@/lib/db/client", () => ({
  prisma: { book: { findFirst: (...args: unknown[]) => findFirst(...args) } },
}));

import { AppError } from "@/lib/errors";

import { requireBookAccess, requireUserId } from "./guards";

describe("guards", () => {
  beforeEach(() => {
    findFirst.mockReset();
  });

  it("rejects a missing user", async () => {
    expect(() => requireUserId(undefined)).toThrow(AppError);
    await expect(requireBookAccess(null, "book1")).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("scopes the lookup to the owner and excludes soft-deleted books", async () => {
    findFirst.mockResolvedValue({ id: "book1", userId: "user1" });
    await expect(requireBookAccess("user1", "book1")).resolves.toEqual({ id: "book1", userId: "user1" });
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: "book1", userId: "user1", deletedAt: null },
      select: { id: true, userId: true },
    });
  });

  it("reports someone else's book as NOT_FOUND", async () => {
    findFirst.mockResolvedValue(null);
    await expect(requireBookAccess("user2", "book1")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
