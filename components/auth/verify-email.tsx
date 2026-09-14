"use client";

import Link from "next/link";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { postJson } from "@/lib/api-client";

import { FormMessage } from "./form-message";

/**
 * Confirmation requires a click rather than happening on page load, so email link scanners
 * that pre-fetch URLs cannot consume the single-use token.
 */
export function VerifyEmail({ token }: { token: string | null }) {
  const [status, setStatus] = useState<"idle" | "submitting" | "done">("idle");
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    if (!token) return;
    setStatus("submitting");
    setError(null);
    const result = await postJson<{ email: string }>("/api/auth/verify", { token });
    if (result.ok) {
      setStatus("done");
    } else {
      setStatus("idle");
      setError(result.error.message);
    }
  }

  if (!token) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Confirmation link missing</CardTitle>
          <CardDescription>Open the link from your email again, or sign in to request a new one.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild variant="outline" className="w-full">
            <Link href="/sign-in">Go to sign in</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (status === "done") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Email confirmed</CardTitle>
          <CardDescription>Your account is ready. Sign in to start.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild className="w-full">
            <Link href="/sign-in?notice=verified">Sign in</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Confirm your email</CardTitle>
        <CardDescription>Confirm this address to finish setting up your SaaKuu account.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error ? (
          <FormMessage tone="error">
            {error}{" "}
            <Link href="/sign-in" className="underline underline-offset-4">
              Sign in to get a new link.
            </Link>
          </FormMessage>
        ) : null}
        <Button onClick={confirm} disabled={status === "submitting"}>
          {status === "submitting" ? "Confirming…" : "Confirm email"}
        </Button>
      </CardContent>
    </Card>
  );
}
