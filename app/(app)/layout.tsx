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
    // The app shell fills the viewport and the page itself never scrolls (docs/05 §0, Phase 13):
    // workspaces scroll inside their panes, and document-shaped pages inside a `PageScroll`.
    <div className="flex h-dvh flex-col overflow-hidden">
      <TopBar user={user} />
      <main className="flex min-h-0 flex-1 flex-col">{children}</main>
    </div>
  );
}
