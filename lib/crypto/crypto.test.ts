import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The one test Phase 12 calls for (docs/06 testing policy): a user's API key must survive the round
 * trip, and must never reach the logs — a key leaked into a log line is a key leaked to whoever reads
 * the logs, and it is the user's money.
 */

const KEY_32 = Buffer.alloc(32, 7).toString("base64");
const SECRET = "AIzaSy-not-a-real-gemini-key-000000-8f2a";

/** `null` means the deployment has no ENCRYPTION_KEY at all. */
async function crypto(encryptionKey: string | null = KEY_32) {
  vi.resetModules();
  process.env.ENCRYPTION_KEY = encryptionKey ?? "";
  return import("./index");
}

const logSpies = () => ({
  log: vi.spyOn(console, "log").mockImplementation(() => {}),
  error: vi.spyOn(console, "error").mockImplementation(() => {}),
});

beforeEach(() => {
  // getEnv() caches, and lib/env only reads process.env — a fresh module registry per case is enough.
  process.env.DATABASE_URL ??= "postgresql://localhost:5432/test";
  process.env.REDIS_URL ??= "redis://localhost:6379";
  process.env.S3_ENDPOINT ??= "http://localhost:9000";
  process.env.S3_ACCESS_KEY_ID ??= "test";
  process.env.S3_SECRET_ACCESS_KEY ??= "test";
  process.env.S3_BUCKET ??= "test";
  process.env.AUTH_SECRET ??= "x".repeat(32);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("secret encryption", () => {
  it("round-trips a key", async () => {
    const { encryptSecret, decryptSecret } = await crypto();
    const stored = encryptSecret(SECRET);
    expect(stored).not.toContain(SECRET);
    expect(decryptSecret(stored)).toBe(SECRET);
  });

  it("produces a different ciphertext every time, so equal keys are not detectable", async () => {
    const { encryptSecret, decryptSecret } = await crypto();
    const a = encryptSecret(SECRET);
    const b = encryptSecret(SECRET);
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe(decryptSecret(b));
  });

  it("refuses a tampered ciphertext rather than returning something else", async () => {
    const { encryptSecret, decryptSecret, SecretCryptoError } = await crypto();
    const parts = encryptSecret(SECRET).split("$");
    const body = Buffer.from(parts[3] ?? "", "base64url");
    body[0] = (body[0] ?? 0) ^ 0xff;
    parts[3] = body.toString("base64url");
    expect(() => decryptSecret(parts.join("$"))).toThrow(SecretCryptoError);
  });

  it("refuses a value encrypted under a different key", async () => {
    const { encryptSecret } = await crypto();
    const stored = encryptSecret(SECRET);
    const { decryptSecret, SecretCryptoError } = await crypto(Buffer.alloc(32, 9).toString("base64"));
    expect(() => decryptSecret(stored)).toThrow(SecretCryptoError);
  });

  it("refuses a malformed or unknown format without throwing anything but SecretCryptoError", async () => {
    const { decryptSecret, SecretCryptoError } = await crypto();
    for (const value of ["", "plaintext", "v0.gcm$a$b$c", "v1.gcm$a$b", "v1.gcm$$$"]) {
      expect(() => decryptSecret(value)).toThrow(SecretCryptoError);
    }
  });

  it("reports a missing ENCRYPTION_KEY instead of storing the key in the clear", async () => {
    const { encryptSecret, encryptionConfigured, SecretCryptoError } = await crypto(null);
    expect(encryptionConfigured()).toBe(false);
    expect(() => encryptSecret(SECRET)).toThrow(SecretCryptoError);
  });

  it("logs nothing, and no failure message carries the key or the ciphertext", async () => {
    const { encryptSecret, decryptSecret } = await crypto();
    const spies = logSpies();
    const stored = encryptSecret(SECRET);
    expect(decryptSecret(stored)).toBe(SECRET);
    try {
      decryptSecret(`${stored}$extra`);
      expect.unreachable("a malformed secret must throw");
    } catch (err) {
      const text = `${(err as Error).message} ${(err as Error).stack ?? ""}`;
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(stored);
    }
    expect(spies.log).not.toHaveBeenCalled();
    expect(spies.error).not.toHaveBeenCalled();
  });

  it("shows only the last four characters as a hint", async () => {
    const { secretHint } = await crypto();
    expect(secretHint(SECRET)).toBe("8f2a");
    expect(secretHint("short")).toBe("");
  });
});
