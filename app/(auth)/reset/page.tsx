import type { Metadata } from "next";

import { ResetForm } from "@/components/auth/reset-form";

export const metadata: Metadata = { title: "Choose a new password · SaaKuu" };

export default async function ResetPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { token } = await searchParams;
  return <ResetForm token={typeof token === "string" && token ? token : null} />;
}
