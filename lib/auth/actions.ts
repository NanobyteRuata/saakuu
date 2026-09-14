"use server";

import { AuthError, CredentialsSignin } from "next-auth";

import { log } from "@/lib/log";

import { signIn, signOut } from "./config";
import { safeCallbackUrl } from "./redirect";

export type PasswordSignInState = {
  error: "invalid" | "email_unverified" | "unavailable" | null;
  email: string;
};

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

/**
 * Email + password sign-in. On success Auth.js redirects (NEXT_REDIRECT is rethrown);
 * on failure the form gets a plain-language error state back.
 */
export async function signInWithPassword(_prev: PasswordSignInState, formData: FormData): Promise<PasswordSignInState> {
  const email = field(formData, "email").trim().toLowerCase();
  try {
    await signIn("credentials", {
      email,
      password: field(formData, "password"),
      redirectTo: safeCallbackUrl(field(formData, "callbackUrl")),
    });
    return { error: null, email };
  } catch (err) {
    if (err instanceof CredentialsSignin) {
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
