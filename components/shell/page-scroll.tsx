import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * The app shell fills the viewport and the page itself never scrolls (docs/05 §0). Workspaces scroll
 * inside their panes; ordinary document-shaped pages — the books list, the create wizard, the account
 * page, error screens — scroll inside this instead.
 */
export function PageScroll({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("min-h-0 flex-1 overflow-y-auto", className)}>{children}</div>;
}
