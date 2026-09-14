import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { TopBar } from "@/components/shell/top-bar";
import { getSessionUser } from "@/lib/auth/session";

/** Authoritative route protection: resolves the session in the database on every request. */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await getSessionUser();
  if (!user) {
    redirect("/sign-in");
  }
  return (
    <div className="flex min-h-screen flex-col">
      <TopBar user={user} />
      <main className="flex-1">{children}</main>
    </div>
  );
}
