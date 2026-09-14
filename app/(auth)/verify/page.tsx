import type { Metadata } from "next";

import { VerifyEmail } from "@/components/auth/verify-email";

export const metadata: Metadata = { title: "Confirm email · SaaKuu" };

export default async function VerifyPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { token } = await searchParams;
  return <VerifyEmail token={typeof token === "string" && token ? token : null} />;
}
