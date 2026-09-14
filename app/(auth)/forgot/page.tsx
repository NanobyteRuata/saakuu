import type { Metadata } from "next";

import { ForgotForm } from "@/components/auth/forgot-form";

export const metadata: Metadata = { title: "Reset password · SaaKuu" };

export default function ForgotPage() {
  return <ForgotForm />;
}
