import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { getEnv } from "@/lib/env";

/**
 * Symmetric encryption for secrets the server must be able to read back — today only a user's own
 * Gemini key (Phase 12, decision 54). AES-256-GCM, so a tampered ciphertext fails to decrypt rather
 * than decrypting to something else.
 *
 * Stored format: `v1.gcm$<ivB64url>$<tagB64url>$<ciphertextB64url>`, self-describing like the scrypt
 * hashes in `lib/auth/password.ts`, so the scheme can change later without a backfill.
 *
 * Nothing here logs. A thrown error never carries the plaintext, the ciphertext or the key: callers
 * turn `SecretCryptoError` into a plain message ("save it again"), because the only useful thing a
 * failure tells anyone is that the value is unusable.
 *
 * `ENCRYPTION_KEY` is 32 bytes, base64 or hex. Rotating it invalidates every stored secret — there is
 * no re-wrap step in v1, so it is backed up with the deployment secrets (docs/09 §8).
 */

const VERSION = "v1.gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export class SecretCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretCryptoError";
  }
}

/** Whether this deployment can store secrets at all, so the UI can say so before anyone types a key. */
export function encryptionConfigured(): boolean {
  return getEnv().ENCRYPTION_KEY !== undefined;
}

function decodeKey(raw: string): Buffer {
  const trimmed = raw.trim();
  const candidates = /^[0-9a-fA-F]+$/.test(trimmed) ? [Buffer.from(trimmed, "hex")] : [Buffer.from(trimmed, "base64")];
  const key = candidates.find((buf) => buf.length === KEY_BYTES);
  if (!key) throw new SecretCryptoError(`ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes (base64 or hex).`);
  return key;
}

function key(): Buffer {
  const raw = getEnv().ENCRYPTION_KEY;
  if (raw === undefined) throw new SecretCryptoError("ENCRYPTION_KEY is not set, so secrets cannot be stored on this server.");
  return decodeKey(raw);
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [VERSION, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), body.toString("base64url")].join("$");
}

/** Throws `SecretCryptoError` for anything unreadable: wrong key, tampered value, or an older format. */
export function decryptSecret(stored: string): string {
  const parts = stored.split("$");
  const [version, ivRaw, tagRaw, bodyRaw] = parts;
  if (parts.length !== 4 || version !== VERSION || !ivRaw || !tagRaw || !bodyRaw) {
    throw new SecretCryptoError("Stored secret is not in a format this server can read.");
  }
  const iv = Buffer.from(ivRaw, "base64url");
  const tag = Buffer.from(tagRaw, "base64url");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new SecretCryptoError("Stored secret is malformed.");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(Buffer.from(bodyRaw, "base64url")), decipher.final()]).toString("utf8");
  } catch (err) {
    if (err instanceof SecretCryptoError) throw err;
    // The GCM tag check failed: wrong key, or the value was changed since it was written.
    throw new SecretCryptoError("Stored secret could not be decrypted.");
  }
}

/** The last four characters, which is all that is ever shown back. Short secrets reveal nothing. */
export function secretHint(plaintext: string): string {
  return plaintext.length >= 8 ? plaintext.slice(-4) : "";
}
