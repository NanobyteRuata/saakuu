import { beforeEach, describe, expect, it, vi } from "vitest";

const { user, session, verificationToken, send, issueToken, consumeToken } = vi.hoisted(() => ({
  user: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  session: { deleteMany: vi.fn() },
  verificationToken: { deleteMany: vi.fn() },
  send: vi.fn(),
  issueToken: vi.fn(),
  consumeToken: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  prisma: {
    user,
    session,
    verificationToken,
    $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops),
  },
}));
vi.mock("@/lib/email/sender", () => ({ getEmailSender: () => ({ send }) }));
vi.mock("@/lib/env", () => ({ getEnv: () => ({ AUTH_URL: "http://app.test" }) }));
vi.mock("./tokens", () => ({ issueToken, consumeToken }));

import { forgotPassword, register, resetPassword, verifyEmail } from "./service";

const input = { email: "a@example.com", password: "password1" };

describe("auth service", () => {
  beforeEach(() => {
    for (const fn of [...Object.values(user), session.deleteMany, verificationToken.deleteMany, send, issueToken, consumeToken]) {
      fn.mockReset();
    }
    issueToken.mockResolvedValue("tok_123");
  });

  describe("register", () => {
    it("creates a new user with a hashed password and sends a verification link", async () => {
      user.findUnique.mockResolvedValue(null);
      user.create.mockResolvedValue({ id: "u1" });

      await expect(register(input)).resolves.toEqual({ emailSent: true });

      const data = user.create.mock.calls[0]?.[0].data;
      expect(data.email).toBe("a@example.com");
      expect(data.passwordHash).toMatch(/^scrypt\$/);
      expect(issueToken).toHaveBeenCalledWith("u1", "EMAIL_VERIFY");
      expect(send.mock.calls[0]?.[0].text).toContain("http://app.test/verify?token=tok_123");
    });

    it("replaces the password of an unverified account and re-sends verification", async () => {
      user.findUnique.mockResolvedValue({ id: "u1", emailVerified: null });

      await expect(register(input)).resolves.toEqual({ emailSent: true });

      expect(user.create).not.toHaveBeenCalled();
      expect(user.update.mock.calls[0]?.[0].where).toEqual({ id: "u1" });
      expect(issueToken).toHaveBeenCalledWith("u1", "EMAIL_VERIFY");
    });

    it("does not touch a verified account and returns the same response", async () => {
      user.findUnique.mockResolvedValue({ id: "u1", emailVerified: new Date() });

      await expect(register(input)).resolves.toEqual({ emailSent: true });

      expect(user.create).not.toHaveBeenCalled();
      expect(user.update).not.toHaveBeenCalled();
      expect(issueToken).not.toHaveBeenCalled();
      expect(send.mock.calls[0]?.[0].subject).toMatch(/already have/i);
    });
  });

  it("verifyEmail rejects an invalid token", async () => {
    consumeToken.mockResolvedValue(null);
    await expect(verifyEmail("bad-token-xxxxxxxxxxxx")).rejects.toMatchObject({ code: "VALIDATION" });
    expect(user.updateMany).not.toHaveBeenCalled();
  });

  it("verifyEmail only sets emailVerified when it is unset", async () => {
    consumeToken.mockResolvedValue("u1");
    user.findUnique.mockResolvedValue({ email: "a@example.com" });
    await expect(verifyEmail("good-token-xxxxxxxxxxx")).resolves.toEqual({ email: "a@example.com" });
    expect(user.updateMany.mock.calls[0]?.[0].where).toEqual({ id: "u1", emailVerified: null });
  });

  it("forgotPassword sends nothing for an unknown address but responds identically", async () => {
    user.findUnique.mockResolvedValue(null);
    await expect(forgotPassword("nobody@example.com")).resolves.toEqual({ emailSent: true });
    expect(send).not.toHaveBeenCalled();
  });

  it("resetPassword sets the hash, verifies the email and signs out every session", async () => {
    consumeToken.mockResolvedValue("u1");
    user.findUnique.mockResolvedValue({ email: "a@example.com", emailVerified: null });

    await expect(resetPassword("reset-token-xxxxxxxxxx", "newpassword2")).resolves.toEqual({ email: "a@example.com" });

    const data = user.update.mock.calls[0]?.[0].data;
    expect(data.passwordHash).toMatch(/^scrypt\$/);
    expect(data.emailVerified).toBeInstanceOf(Date);
    expect(session.deleteMany).toHaveBeenCalledWith({ where: { userId: "u1" } });
  });

  it("resetPassword rejects a used or expired token", async () => {
    consumeToken.mockResolvedValue(null);
    await expect(resetPassword("reset-token-xxxxxxxxxx", "newpassword2")).rejects.toMatchObject({ code: "VALIDATION" });
    expect(user.update).not.toHaveBeenCalled();
  });
});
