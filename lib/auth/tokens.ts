import { createHash, randomBytes } from "node:crypto";

import { prisma } from "@/lib/db/client";

/**
 * Single-use emailed tokens (email verification, password reset).
 *
 * Only the sha256 of the token is stored, so a database read does not yield usable links.
 * `identifier` is the user id. Issuing a new token revokes earlier ones of the same purpose.
 */

export type TokenPurpose = "EMAIL_VERIFY" | "PASSWORD_RESET";

export const TOKEN_TTL_MS: Record<TokenPurpose, number> = {
  EMAIL_VERIFY: 24 * 60 * 60 * 1000,
  PASSWORD_RESET: 60 * 60 * 1000,
};

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function issueToken(userId: string, purpose: TokenPurpose, now = new Date()): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await prisma.$transaction([
    prisma.verificationToken.deleteMany({ where: { identifier: userId, purpose } }),
    prisma.verificationToken.create({
      data: {
        identifier: userId,
        token: hashToken(token),
        purpose,
        expires: new Date(now.getTime() + TOKEN_TTL_MS[purpose]),
      },
    }),
  ]);
  return token;
}

export async function revokeTokens(userId: string, purpose: TokenPurpose): Promise<void> {
  await prisma.verificationToken.deleteMany({ where: { identifier: userId, purpose } });
}

/**
 * Consumes a token and returns its user id, or null when it is unknown, expired, for another
 * purpose, or already used. The delete is the claim: of two concurrent consumers only one
 * deletes a row, so a token can never be used twice.
 */
export async function consumeToken(token: string, purpose: TokenPurpose, now = new Date()): Promise<string | null> {
  const tokenHash = hashToken(token);
  const row = await prisma.verificationToken.findUnique({ where: { token: tokenHash } });
  if (!row || row.purpose !== purpose) return null;

  const { count } = await prisma.verificationToken.deleteMany({ where: { token: tokenHash, purpose } });
  if (count !== 1) return null;
  if (row.expires.getTime() <= now.getTime()) return null;
  return row.identifier;
}
