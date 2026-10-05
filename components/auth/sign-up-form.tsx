"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { postJson } from "@/lib/api-client";
import { PASSWORD_RULES, registerSchema } from "@/lib/auth/schemas";
import { cn } from "@/lib/utils";

import { FormMessage } from "./form-message";
import { GoogleButton, OrDivider } from "./google-button";

export function PasswordRules({ password }: { password: string }) {
  return (
    <ul className="flex flex-col gap-1 text-xs" aria-label="Password requirements">
      {PASSWORD_RULES.map((rule) => {
        const met = rule.test(password);
        return (
          <li key={rule.id} className={cn(met ? "text-emerald-700 dark:text-emerald-400" : "text-muted-foreground")}>
            <span aria-hidden="true">{met ? "✓" : "○"}</span> {rule.label}
            <span className="sr-only">{met ? " (met)" : " (not met)"}</span>
          </li>
        );
      })}
    </ul>
  );
}

export function SignUpForm({ googleEnabled, inviteOnly }: { googleEnabled: boolean; inviteOnly: boolean }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const parsed = registerSchema.safeParse({ email, password });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Check your email and password.");
      return;
    }
    setStatus("submitting");
    const result = await postJson("/api/auth/register", parsed.data);
    if (result.ok) {
      setStatus("sent");
    } else {
      setStatus("idle");
      setError(result.error.message);
    }
  }

  if (status === "sent") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Check your email</CardTitle>
          <CardDescription>
            We sent a confirmation link to <span className="text-foreground font-medium">{email.trim().toLowerCase()}</span>.
            Open it to finish creating your account. The link expires in 24 hours.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild variant="outline" className="w-full">
            <Link href="/sign-in">Back to sign in</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Create your account</CardTitle>
        <CardDescription>
          {inviteOnly
            ? "SaaKuu is invite-only for now. Use the email address you were invited with; you'll confirm it before you can start."
            : "You'll confirm your email before you can start."}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {googleEnabled ? (
          <>
            <GoogleButton callbackUrl="/books" />
            <OrDivider />
          </>
        ) : null}

        <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
          {error ? <FormMessage tone="error">{error}</FormMessage> : null}
          <div className="flex flex-col gap-2">
            <Label htmlFor="email">Email</Label>
            <Input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              autoComplete="new-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <PasswordRules password={password} />
          </div>
          <Button type="submit" disabled={status === "submitting"}>
            {status === "submitting" ? "Creating account…" : "Create account"}
          </Button>
        </form>

        <p className="text-muted-foreground text-center text-sm">
          Already have an account?{" "}
          <Link href="/sign-in" className="text-foreground underline-offset-4 hover:underline">
            Sign in
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
