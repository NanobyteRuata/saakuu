import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { SignInForm } from "@/components/auth/sign-in-form";
import { isGoogleConfigured } from "@/lib/auth/config";
import { safeCallbackUrl } from "@/lib/auth/redirect";
import { getSessionUser } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Sign in · SaaKuu" };

const NOTICES: Record<string, string> = {
  verified: "Your email is confirmed. Sign in to continue.",
  reset: "Your password has been changed. Sign in with the new password.",
};

function first(value: string | string[] | undefined): string | null {
  return (Array.isArray(value) ? value[0] : value) ?? null;
}

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const callbackUrl = safeCallbackUrl(first(params.callbackUrl));

  if (await getSessionUser()) {
    redirect(callbackUrl);
  }

  const notice = first(params.notice);
  return (
    <SignInForm
      callbackUrl={callbackUrl}
      googleEnabled={isGoogleConfigured()}
      urlError={first(params.error)}
      notice={notice ? (NOTICES[notice] ?? null) : null}
    />
  );
}
