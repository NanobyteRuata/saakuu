import Link from "next/link";
import type { ReactNode } from "react";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 px-4 py-12">
      <Link href="/" className="text-xl font-semibold tracking-tight">
        SaaKuu
      </Link>
      <div className="w-full max-w-sm">{children}</div>
    </main>
  );
}
