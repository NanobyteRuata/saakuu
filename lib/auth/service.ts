import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db/client";
import { getEnv } from "@/lib/env";
import { getEmailSender } from "@/lib/email/sender";
import { accountExistsMessage, resetPasswordMessage, verifyEmailMessage } from "@/lib/email/templates";
import { AppError } from "@/lib/errors";

import { hashPassword } from "./password";
import type { RegisterInput } from "./schemas";
import { consumeToken, issueToken } from "./tokens";

/**
 * Credentials account lifecycle: register, verify, resend, forgot, reset.
 *
 * Endpoints that take an email address return the same result whether or not an account
 * exists, so they cannot be used to discover who has an account.
 */

export type EmailSentResult = { emailSent: true };
const EMAIL_SENT: EmailSentResult = { emailSent: true };

const INVALID_LINK = "This link is invalid or has expired. Request a new one.";

function appUrl(path: string, params?: Record<string, string>): string {
  const url = new URL(path, getEnv().AUTH_URL);
  for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);
  return url.toString();
}

async function sendVerification(userId: string, email: string): Promise<void> {
  const token = await issueToken(userId, "EMAIL_VERIFY");
  await getEmailSender().send(verifyEmailMessage(email, appUrl("/verify", { token })));
}

export async function register(input: RegisterInput): Promise<EmailSentResult> {
  const passwordHash = await hashPassword(input.password);
  const existing = await prisma.user.findUnique({
    where: { email: input.email },
    select: { id: true, emailVerified: true },
  });

  if (existing?.emailVerified) {
    await getEmailSender().send(accountExistsMessage(input.email, appUrl("/sign-in"), appUrl("/forgot")));
    return EMAIL_SENT;
  }

  if (existing) {
    // Unverified: the latest registration wins, and older verification links stop working.
    await prisma.user.update({
      where: { id: existing.id },
      data: { passwordHash, ...(input.name ? { name: input.name } : {}) },
    });
    await sendVerification(existing.id, input.email);
    return EMAIL_SENT;
  }

  try {
    const user = await prisma.user.create({
      data: { email: input.email, passwordHash, name: input.name || null },
      select: { id: true },
    });
    await sendVerification(user.id, input.email);
  } catch (err) {
    // A concurrent registration for the same address won the race; respond identically.
    if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
  }
  return EMAIL_SENT;
}

export async function verifyEmail(token: string): Promise<{ email: string }> {
  const userId = await consumeToken(token, "EMAIL_VERIFY");
  if (!userId) throw new AppError("VALIDATION", INVALID_LINK);

  await prisma.user.updateMany({ where: { id: userId, emailVerified: null }, data: { emailVerified: new Date() } });
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
  if (!user) throw new AppError("VALIDATION", INVALID_LINK);
  return { email: user.email };
}

export async function resendVerification(email: string): Promise<EmailSentResult> {
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, emailVerified: true, passwordHash: true },
  });
  if (user && !user.emailVerified && user.passwordHash) {
    await sendVerification(user.id, email);
  }
  return EMAIL_SENT;
}

/** Also lets a Google-only user add a password to their account. */
export async function forgotPassword(email: string): Promise<EmailSentResult> {
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (user) {
    const token = await issueToken(user.id, "PASSWORD_RESET");
    await getEmailSender().send(resetPasswordMessage(email, appUrl("/reset", { token })));
  }
  return EMAIL_SENT;
}

/**
 * Sets the new password, marks the email verified (the emailed link proved ownership) and
 * signs the user out of every existing session.
 */
export async function resetPassword(token: string, password: string): Promise<{ email: string }> {
  const passwordHash = await hashPassword(password);
  const userId = await consumeToken(token, "PASSWORD_RESET");
  if (!userId) throw new AppError("VALIDATION", INVALID_LINK);

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, emailVerified: true } });
  if (!user) throw new AppError("VALIDATION", INVALID_LINK);

  await prisma.$transaction([
    prisma.user.update({
      where: { id: userId },
      data: { passwordHash, ...(user.emailVerified ? {} : { emailVerified: new Date() }) },
    }),
    prisma.session.deleteMany({ where: { userId } }),
    prisma.verificationToken.deleteMany({ where: { identifier: userId, purpose: "EMAIL_VERIFY" } }),
  ]);
  return { email: user.email };
}
