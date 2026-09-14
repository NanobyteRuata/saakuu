"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

const TABS = [
  { label: "Table", segment: "" },
  { label: "Templates", segment: "templates" },
  { label: "Documents", segment: "documents" },
  { label: "Settings", segment: "settings" },
] as const;

export function BookTabs({ bookId }: { bookId: string }) {
  const pathname = usePathname();
  const root = `/books/${bookId}`;
  return (
    <nav aria-label="Book sections" className="flex gap-1 overflow-x-auto border-b">
      {TABS.map(({ label, segment }) => {
        const href = segment ? `${root}/${segment}` : root;
        const active = segment ? pathname === href || pathname.startsWith(`${href}/`) : pathname === root;
        return (
          <Link
            key={label}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors",
              active ? "border-foreground text-foreground" : "text-muted-foreground hover:text-foreground border-transparent",
            )}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
