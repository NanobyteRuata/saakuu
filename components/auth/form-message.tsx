import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/** Inline status message for auth forms. Announced to screen readers; icon-free but worded. */
export function FormMessage({ tone, children }: { tone: "error" | "success" | "info"; children: ReactNode }) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "rounded-md border px-3 py-2 text-sm",
        tone === "error" && "border-destructive/40 bg-destructive/5 text-destructive",
        tone === "success" && "border-emerald-600/30 bg-emerald-600/5 text-emerald-800 dark:text-emerald-300",
        tone === "info" && "bg-muted text-foreground",
      )}
    >
      {children}
    </div>
  );
}
