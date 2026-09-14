import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = { identifier: string; token: string; purpose: string; expires: Date };
const rows: Row[] = [];

vi.mock("@/lib/db/client", () => {
  const verificationToken = {
    deleteMany: async ({ where }: { where: Partial<Row> }) => {
      const before = rows.length;
      for (let i = rows.length - 1; i >= 0; i--) {
        const row = rows[i];
        if (row && Object.entries(where).every(([k, v]) => row[k as keyof Row] === v)) rows.splice(i, 1);
      }
      return { count: before - rows.length };
    },
    create: async ({ data }: { data: Row }) => {
      rows.push(data);
      return data;
    },
    findUnique: async ({ where }: { where: { token: string } }) => rows.find((r) => r.token === where.token) ?? null,
  };
  return {
    prisma: {
      verificationToken,
      $transaction: async (ops: Promise<unknown>[]) => {
        const results = [];
        for (const op of ops) results.push(await op);
        return results;
      },
    },
  };
});

import { consumeToken, hashToken, issueToken, TOKEN_TTL_MS } from "./tokens";

describe("tokens", () => {
  beforeEach(() => {
    rows.length = 0;
  });

  it("stores only the hash of the token", async () => {
    const token = await issueToken("user1", "EMAIL_VERIFY");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.token).toBe(hashToken(token));
    expect(rows[0]?.token).not.toBe(token);
  });

  it("is single use", async () => {
    const token = await issueToken("user1", "PASSWORD_RESET");
    await expect(consumeToken(token, "PASSWORD_RESET")).resolves.toBe("user1");
    await expect(consumeToken(token, "PASSWORD_RESET")).resolves.toBeNull();
  });

  it("rejects a token used for the wrong purpose without burning it", async () => {
    const token = await issueToken("user1", "EMAIL_VERIFY");
    await expect(consumeToken(token, "PASSWORD_RESET")).resolves.toBeNull();
    await expect(consumeToken(token, "EMAIL_VERIFY")).resolves.toBe("user1");
  });

  it("rejects an expired token", async () => {
    const issuedAt = new Date("2026-01-01T00:00:00Z");
    const token = await issueToken("user1", "PASSWORD_RESET", issuedAt);
    const later = new Date(issuedAt.getTime() + TOKEN_TTL_MS.PASSWORD_RESET + 1);
    await expect(consumeToken(token, "PASSWORD_RESET", later)).resolves.toBeNull();
  });

  it("expires reset links after 1 hour", () => {
    expect(TOKEN_TTL_MS.PASSWORD_RESET).toBe(60 * 60 * 1000);
  });

  it("revokes earlier tokens of the same purpose when issuing a new one", async () => {
    const first = await issueToken("user1", "EMAIL_VERIFY");
    const second = await issueToken("user1", "EMAIL_VERIFY");
    await expect(consumeToken(first, "EMAIL_VERIFY")).resolves.toBeNull();
    await expect(consumeToken(second, "EMAIL_VERIFY")).resolves.toBe("user1");
  });

  it("rejects unknown tokens", async () => {
    await expect(consumeToken("not-a-real-token-at-all", "EMAIL_VERIFY")).resolves.toBeNull();
  });
});
