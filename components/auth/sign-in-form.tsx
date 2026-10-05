"use client";

import Link from "next/link";
import { useActionState, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { signInWithPassword, type PasswordSignInState } from "@/lib/auth/actions";
import { postJson } from "@/lib/api-client";

import { FormMessage } from "./form-message";
import { GoogleButton, OrDivider } from "./google-button";

/** Errors that arrive as `?error=` from Auth.js or our signIn callback redirect. */
const URL_ERRORS: Record<string, string> = {
  VerifyEmailFirst:
    "There is already a SaaKuu account with this email that hasn't been confirmed. Confirm it from the email we sent (or send a new link below), then continue with Google.",
  GoogleEmailUnverified: "Google hasn't verified this email address, so it can't be used to sign in.",
  InviteOnly: "SaaKuu is invite-only for now, and this Google account hasn't been invited. Ask for an invitation with this email address.",
  OAuthAccountNotLinked: "This email is already used by another sign-in method. Sign in with your password instead.",
  AccessDenied: "Sign-in was cancelled or not allowed.",
  Configuration: "Sign-in isn't available right now. Try again in a moment.",
};

const ACTION_ERRORS: Record<Exclude<PasswordSignInState["error"], null>, string> = {
  invalid: "That email and password don't match an account.",
  email_unverified: "Confirm your email address before signing in. Check your inbox for the link.",
  unavailable: "Sign-in isn't available right now. Try again in a moment.",
  rate_limited: "Too many sign-in attempts. Wait 15 minutes and try again, or reset your password.",
};

export function SignInForm({
  callbackUrl,
  googleEnabled,
  urlError,
  notice,
}: {
  callbackUrl: string;
  googleEnabled: boolean;
  urlError: string | null;
  notice: string | null;
}) {
  const [state, formAction, pending] = useActionState(signInWithPassword, { error: null, email: "" });
  const [resend, setResend] = useState<"idle" | "sending" | "sent" | "failed">("idle");
  const [email, setEmail] = useState("");

  const needsVerification = state.error === "email_unverified" || urlError === "VerifyEmailFirst";
  const message = state.error ? ACTION_ERRORS[state.error] : urlError ? (URL_ERRORS[urlError] ?? URL_ERRORS.Configuration) : null;

  async function resendVerification() {
    const address = state.email || email;
    if (!address) return;
    setResend("sending");
    const result = await postJson("/api/auth/resend-verification", { email: address });
    setResend(result.ok ? "sent" : "failed");
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sign in</CardTitle>
        <CardDescription>Welcome back to SaaKuu.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {notice && !message ? <FormMessage tone="success">{notice}</FormMessage> : null}
        {message ? <FormMessage tone="error">{message}</FormMessage> : null}

        {googleEnabled ? (
          <>
            <GoogleButton callbackUrl={callbackUrl} />
            <OrDivider />
          </>
        ) : null}

        <form action={formAction} className="flex flex-col gap-4">
          <input type="hidden" name="callbackUrl" value={callbackUrl} />
          <div className="flex flex-col gap-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              defaultValue={state.email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="password">Password</Label>
              <Link href="/forgot" className="text-muted-foreground text-xs underline-offset-4 hover:underline">
                Forgot password?
              </Link>
            </div>
            <Input id="password" name="password" type="password" autoComplete="current-password" required />
          </div>
          <Button type="submit" disabled={pending}>
            {pending ? "Signing in…" : "Sign in"}
          </Button>
        </form>

        {needsVerification ? (
          <div className="flex flex-col gap-2 text-sm">
            <Button type="button" variant="outline" onClick={resendVerification} disabled={resend === "sending" || !(state.email || email)}>
              {resend === "sending" ? "Sending…" : "Send a new confirmation link"}
            </Button>
            {resend === "sent" ? <FormMessage tone="success">If that account needs confirming, a new link is on its way.</FormMessage> : null}
            {resend === "failed" ? <FormMessage tone="error">We couldn&apos;t send the link. Try again in a moment.</FormMessage> : null}
            {!(state.email || email) ? <p className="text-muted-foreground text-xs">Enter your email above to get a new link.</p> : null}
          </div>
        ) : null}

        <p className="text-muted-foreground text-center text-sm">
          New to SaaKuu?{" "}
          <Link href="/sign-up" className="text-foreground underline-offset-4 hover:underline">
            Create an account
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
