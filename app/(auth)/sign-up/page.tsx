import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { SignUpForm } from "@/components/auth/sign-up-form";
import { inviteOnly } from "@/lib/auth/allowlist";
import { isGoogleConfigured } from "@/lib/auth/config";
import { DEFAULT_SIGNED_IN_PATH } from "@/lib/auth/redirect";
import { getSessionUser } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Create account · SaaKuu" };

export default async function SignUpPage() {
  if (await getSessionUser()) {
    redirect(DEFAULT_SIGNED_IN_PATH);
  }
  return <SignUpForm googleEnabled={isGoogleConfigured()} inviteOnly={inviteOnly()} />;
}
