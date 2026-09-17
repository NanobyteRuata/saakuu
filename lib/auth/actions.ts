"use server";

import { headers } from "next/headers";
import { AuthError, CredentialsSignin } from "next-auth";

import { log } from "@/lib/log";
import { hitRateLimit, peekRateLimit } from "@/lib/rate-limit";
import { clientIp } from "@/lib/request-ip";

import { signIn, signOut } from "./config";
import { safeCallbackUrl } from "./redirect";

export type PasswordSignInState = {
  error: "invalid" | "email_unverified" | "unavailable" | "rate_limited" | null;
  email: string;
};

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

/**
 * Email + password sign-in. On success Auth.js redirects (NEXT_REDIRECT is rethrown);
 * on failure the form gets a plain-language error state back. Failures are counted per email at one address
 * (the lockout a stranger could cause is limited to their own address), per email alone (a looser backstop), and
 * per address; once any is exhausted the password isn't checked at all.
 */
export async function signInWithPassword(_prev: PasswordSignInState, formData: FormData): Promise<PasswordSignInState> {
  const email = field(formData, "email").trim().toLowerCase();
  const ip = clientIp(await headers());
  const emailAtIp = `${email}|${ip}`;
  const checks = await Promise.all([
    peekRateLimit("signInFailEmailIp", emailAtIp),
    peekRateLimit("signInFailEmail", email),
    peekRateLimit("signInFailIp", ip),
  ]);
  if (checks.some((c) => c.limited)) {
    log.warn("password sign-in rate limited");
    return { error: "rate_limited", email };
  }
  try {
    await signIn("credentials", {
      email,
      password: field(formData, "password"),
      redirectTo: safeCallbackUrl(field(formData, "callbackUrl")),
    });
    return { error: null, email };
  } catch (err) {
    if (err instanceof CredentialsSignin) {
      await Promise.all([
        hitRateLimit("signInFailEmailIp", emailAtIp),
        hitRateLimit("signInFailEmail", email),
        hitRateLimit("signInFailIp", ip),
      ]);
      return { error: err.code === "email_unverified" ? "email_unverified" : "invalid", email };
    }
    if (err instanceof AuthError) {
      log.error("password sign-in failed", err);
      return { error: "unavailable", email };
    }
    throw err;
  }
}

export async function signInWithGoogle(formData: FormData): Promise<void> {
  await signIn("google", { redirectTo: safeCallbackUrl(field(formData, "callbackUrl")) });
}

export async function signOutAction(): Promise<void> {
  await signOut({ redirectTo: "/sign-in" });
}
